import { Prisma, type Order, type PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { assertTransition, convert, IllegalTransitionError, ORDER_TRANSITIONS, UnitError, type OrderState, type UnitCode } from "@supplypiper/domain";
import { getAuth, requireSession } from "./auth";
import { ApiError } from "./errors";
import { audit, enqueueEmail, validate, type Tx } from "./helpers";
import { fmtMoney, param, positiveQuantity, qtyString } from "./loaders";
import { getScope, requireOrgPermission } from "./orgs";
import { ser } from "./serialize";

const note = z.string().trim().max(1000).optional();

export function ordersRouter(prisma: PrismaClient): Router {
  const r = Router();
  r.use(requireSession);

  const asParty = async (orgId: string, orderId: string): Promise<{ order: Order; side: "buyer" | "supplier" }> => {
    const order = await prisma.order.findFirst({ where: { id: orderId, OR: [{ buyerOrgId: orgId }, { supplierOrgId: orgId }] } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    return { order, side: order.buyerOrgId === orgId ? "buyer" : "supplier" };
  };
  const supplierOrder = async (orgId: string, id: string) => {
    const order = await prisma.order.findFirst({ where: { id, supplierOrgId: orgId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    return order;
  };
  const buyerOrder = async (orgId: string, id: string) => {
    const order = await prisma.order.findFirst({ where: { id, buyerOrgId: orgId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    return order;
  };

  /** Optimistic, atomic transition: fails if another tab or retry moved the order first. */
  async function move(tx: Tx, order: Order, to: OrderState): Promise<void> {
    try { assertTransition(ORDER_TRANSITIONS, order.state, to); } catch (e) {
      if (e instanceof IllegalTransitionError) throw new ApiError(409, "ILLEGAL_STATE", `An order that is "${order.state}" cannot move to "${to}"`);
      throw e;
    }
    const c = await tx.order.updateMany({ where: { id: order.id, state: order.state, version: order.version }, data: { state: to, version: { increment: 1 } } });
    if (c.count !== 1) throw new ApiError(409, "ORDER_CHANGED", "The order was updated elsewhere. Refresh and try again.");
  }
  const record = (tx: Tx, orderId: string, party: "buyer" | "supplier", kind: string, extra: { quantityScaled?: bigint; note?: string } = {}) =>
    tx.deliveryUpdate.create({ data: { orderId, party, kind, quantityScaled: extra.quantityScaled, note: extra.note } });

  r.get("/orgs/:orgId/orders", requireOrgPermission(prisma, "order.view"), async (_req, res) => {
    const s = getScope(res);
    const rows = await prisma.order.findMany({ where: { OR: [{ buyerOrgId: s.orgId }, { supplierOrgId: s.orgId }] }, orderBy: { createdAt: "desc" }, take: 100 });
    res.json(ser({ orders: rows.map((o) => ({ id: o.id, state: o.state, side: o.buyerOrgId === s.orgId ? "buyer" : "supplier", total: fmtMoney(o.totalMinor, o.currency), totalMinor: o.totalMinor, createdAt: o.createdAt })) }));
  });

  r.get("/orgs/:orgId/orders/:id", requireOrgPermission(prisma, "order.view"), async (req, res) => {
    const { order, side } = await asParty(getScope(res).orgId, param(req, "id"));
    const [updates, orgs] = await Promise.all([
      prisma.deliveryUpdate.findMany({ where: { orderId: order.id }, include: { discrepancy: true }, orderBy: { createdAt: "asc" } }),
      prisma.organisation.findMany({ where: { id: { in: [order.buyerOrgId, order.supplierOrgId] } } }),
    ]);
    res.json(ser({
      id: order.id, state: order.state, side, total: fmtMoney(order.totalMinor, order.currency), totalMinor: order.totalMinor, currency: order.currency,
      buyer: orgs.find((o) => o.id === order.buyerOrgId)?.name, supplier: orgs.find((o) => o.id === order.supplierOrgId)?.name,
      snapshot: order.snapshot, updates: updates.map((u) => ({ id: u.id, party: u.party, kind: u.kind, quantityScaled: u.quantityScaled, note: u.note, at: u.createdAt, discrepancy: u.discrepancy })),
      notes: ["Supplier acceptance does not prove delivery.", "Only the buyer can confirm receipt."],
    }));
  });

  // ---------- supplier commands ----------
  r.post("/orgs/:orgId/orders/:id/accept", requireOrgPermission(prisma, "order.accept"), async (req, res) => {
    const s = getScope(res);
    const order = await supplierOrder(s.orgId, param(req, "id"));
    await prisma.$transaction(async (tx) => {
      await move(tx, order, "accepted");
      const qv = await tx.quoteVersion.findUniqueOrThrow({ where: { id: order.quoteVersionId } });
      if (qv.productId) {
        const st = await tx.inventoryStatement.findFirst({ where: { productId: qv.productId }, orderBy: { statedAt: "desc" }, include: { product: true } });
        let need: bigint;
        try { need = convert({ scaled: qv.offeredScaled, unit: qv.offeredUnit as UnitCode }, st?.product.unit as UnitCode).scaled; }
        catch (e) { if (e instanceof UnitError) throw new ApiError(409, "STOCK_UNIT_MISMATCH", "The quote's unit cannot be matched to the product's stock unit"); throw e; }
        if (!st) throw new ApiError(409, "STOCK_CONFLICT", "No stock statement exists for this product");
        // Atomic conditional update: two simultaneous acceptances can never reserve more than is available.
        const n = await tx.$executeRaw`UPDATE "InventoryStatement" SET "reservedScaled" = "reservedScaled" + ${need} WHERE id = ${st.id} AND "reservedScaled" + ${need} <= "availableScaled"`;
        if (n !== 1) throw new ApiError(409, "STOCK_CONFLICT", "Not enough declared stock remains. Update your inventory or decline the order.");
      }
      await record(tx, order.id, "supplier", "accepted");
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "order.accepted", objectType: "Order", objectId: order.id });
      const buyers = await tx.membership.findMany({ where: { orgId: order.buyerOrgId, role: { in: ["owner", "buyer_approver"] } }, include: { user: true } });
      for (const to of new Set(buyers.map((m) => m.user.email))) await enqueueEmail(tx, to, "order_accepted", { orderId: order.id });
    });
    res.json({ state: "accepted" });
  });

  r.post("/orgs/:orgId/orders/:id/decline", requireOrgPermission(prisma, "order.accept"), async (req, res) => {
    const b = validate(z.object({ reason: z.string().trim().min(1).max(500) }), req.body);
    const s = getScope(res);
    const order = await supplierOrder(s.orgId, param(req, "id"));
    await prisma.$transaction(async (tx) => {
      await move(tx, order, "declined");
      await record(tx, order.id, "supplier", "declined", { note: b.reason });
      await tx.procurementRequest.update({ where: { id: order.requestId }, data: { state: "ready_for_comparison" } }); // buyer may choose again
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "order.declined", objectType: "Order", objectId: order.id });
    });
    res.json({ state: "declined" });
  });

  r.post("/orgs/:orgId/orders/:id/progress", requireOrgPermission(prisma, "order.accept"), async (req, res) => {
    const b = validate(z.object({ to: z.enum(["preparing", "dispatched", "delivered"]), note }), req.body);
    const s = getScope(res);
    const order = await supplierOrder(s.orgId, param(req, "id"));
    const target: OrderState = b.to === "delivered" ? "delivered_awaiting_buyer_confirmation" : b.to;
    await prisma.$transaction(async (tx) => {
      await move(tx, order, target);
      // A supplier's "delivered" is only a supplier report; receipt stays a buyer-only action.
      await record(tx, order.id, "supplier", b.to === "delivered" ? "supplier_reports_delivered" : b.to, { note: b.note });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: `order.${b.to}`, objectType: "Order", objectId: order.id });
    });
    res.json({ state: target });
  });

  r.post("/orgs/:orgId/orders/:id/discrepancy-response", requireOrgPermission(prisma, "order.accept"), async (req, res) => {
    const b = validate(z.object({ note: z.string().trim().min(1).max(1000), quantity: qtyString.optional() }), req.body);
    const s = getScope(res);
    const order = await supplierOrder(s.orgId, param(req, "id"));
    const d = await prisma.discrepancy.findFirst({ where: { status: "open", update: { orderId: order.id } } });
    if (!d) throw new ApiError(409, "NO_OPEN_DISCREPANCY", "There is no open buyer report to respond to");
    await prisma.$transaction(async (tx) => {
      await tx.discrepancy.update({ where: { id: d.id }, data: { supplierReport: { note: b.note, quantity: b.quantity ?? null, at: new Date().toISOString(), by: getAuth(res).user.id } } });
      await record(tx, order.id, "supplier", "discrepancy_response", { note: b.note });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "discrepancy.supplier_responded", objectType: "Discrepancy", objectId: d.id });
    });
    res.json({ status: "recorded", note: "The buyer's report and your response are both kept. Neither overwrites the other." });
  });

  // ---------- buyer commands ----------
  r.post("/orgs/:orgId/orders/:id/cancel", requireOrgPermission(prisma, "approval.approve"), async (req, res) => {
    const s = getScope(res);
    const order = await buyerOrder(s.orgId, param(req, "id"));
    if (order.state !== "awaiting_supplier_acceptance") throw new ApiError(409, "CHANGE_REQUEST_REQUIRED", "After supplier acceptance, changes need a change request, which is not available yet.");
    await prisma.$transaction(async (tx) => {
      await move(tx, order, "cancelled");
      await tx.procurementRequest.update({ where: { id: order.requestId }, data: { state: "ready_for_comparison" } });
      await record(tx, order.id, "buyer", "cancelled");
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "order.cancelled", objectType: "Order", objectId: order.id });
    });
    res.json({ state: "cancelled" });
  });

  r.post("/orgs/:orgId/orders/:id/receipt", requireOrgPermission(prisma, "order.confirm_receipt"), async (req, res) => {
    const b = validate(z.object({ outcome: z.enum(["full", "partial", "problem"]), receivedQuantity: qtyString.optional(), note }), req.body);
    const s = getScope(res);
    const order = await buyerOrder(s.orgId, param(req, "id"));
    const snap = order.snapshot as { quoteVersion: { offeredScaled: string; offeredUnit: UnitCode } };
    const ordered = { scaled: BigInt(snap.quoteVersion.offeredScaled), unit: snap.quoteVersion.offeredUnit };
    let received: bigint | undefined;
    if (b.outcome === "partial") {
      if (!b.receivedQuantity) throw new ApiError(400, "VALIDATION_FAILED", "State how much you received", { receivedQuantity: "Required for partial receipt" });
      received = positiveQuantity(b.receivedQuantity, ordered.unit).scaled;
      if (received >= ordered.scaled) throw new ApiError(400, "VALIDATION_FAILED", "Partial receipt must be less than the quantity ordered", { receivedQuantity: "Must be less than ordered" });
    }
    const target: OrderState = b.outcome === "full" ? "completed" : b.outcome === "partial" ? "partially_fulfilled" : "issue_reported";
    await prisma.$transaction(async (tx) => {
      await move(tx, order, target);
      const u = await record(tx, order.id, "buyer", `receipt_${b.outcome}`, { quantityScaled: received, note: b.note });
      if (b.outcome !== "full") {
        await tx.discrepancy.create({ data: { updateId: u.id, buyerReport: { outcome: b.outcome, receivedScaled: received?.toString() ?? null, orderedScaled: ordered.scaled.toString(), note: b.note ?? null, at: new Date().toISOString(), by: getAuth(res).user.id } } });
      } else await tx.procurementRequest.update({ where: { id: order.requestId }, data: { state: "closed" } });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: `order.receipt_${b.outcome}`, objectType: "Order", objectId: order.id });
    });
    res.json({ state: target });
  });

  r.post("/orgs/:orgId/orders/:id/discrepancy-resolution", requireOrgPermission(prisma, "order.confirm_receipt"), async (req, res) => {
    const b = validate(z.object({ note: z.string().trim().min(1).max(1000) }), req.body);
    const s = getScope(res);
    const order = await buyerOrder(s.orgId, param(req, "id"));
    const d = await prisma.discrepancy.findFirst({ where: { status: "open", update: { orderId: order.id } } });
    if (!d) throw new ApiError(409, "NO_OPEN_DISCREPANCY", "There is no open discrepancy on this order");
    await prisma.$transaction(async (tx) => {
      await move(tx, order, "completed");
      // Both reports stay as recorded; the resolution is an added statement by the buyer, not a ruling.
      await tx.discrepancy.update({ where: { id: d.id }, data: { status: "closed_by_buyer", resolution: { note: b.note, by: getAuth(res).user.id, at: new Date().toISOString() } } });
      await tx.procurementRequest.update({ where: { id: order.requestId }, data: { state: "closed" } });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "discrepancy.closed_by_buyer", objectType: "Discrepancy", objectId: d.id });
    });
    res.json({ state: "completed" });
  });

  // ---------- export ----------
  r.get("/orgs/:orgId/orders/:id/export", requireOrgPermission(prisma, "order.view"), async (req, res) => {
    const s = getScope(res);
    const { order, side } = await asParty(s.orgId, param(req, "id"));
    const updates = await prisma.deliveryUpdate.findMany({ where: { orderId: order.id }, include: { discrepancy: true }, orderBy: { createdAt: "asc" } });
    const audits = await prisma.auditEvent.findMany({ where: { orgId: s.orgId, objectId: { in: [order.id, order.requestId, order.approvalId] } }, orderBy: { createdAt: "asc" }, select: { event: true, createdAt: true, actorUserId: true } });
    // Competing suppliers' quotes (comparison runs) are never exported to the supplier side.
    const buyerOnly = side === "buyer"
      ? { approval: await prisma.approval.findUnique({ where: { id: order.approvalId }, select: { id: true, approverUserId: true, quoteVersionId: true, totalMinor: true, currency: true, expiresAt: true, createdAt: true } }) }
      : {};
    res.json(ser({
      format: "supplypiper-order-evidence/1", generatedAt: new Date(), viewedBy: side,
      order: { id: order.id, state: order.state, total: fmtMoney(order.totalMinor, order.currency), totalMinor: order.totalMinor, currency: order.currency, createdAt: order.createdAt },
      snapshot: order.snapshot, ...buyerOnly,
      updates: updates.map((u) => ({ party: u.party, kind: u.kind, quantityScaled: u.quantityScaled, note: u.note, at: u.createdAt, discrepancy: u.discrepancy })),
      activity: audits,
      limits: [
        "Supplier statements are the supplier's own and are not verified by SupplyPiper.",
        "Supplier acceptance does not prove delivery; receipt is confirmed only by the buyer.",
        "Local activity records are not immutable and not blockchain-backed.",
        "Identity verification (when used) does not establish product quality, business registration or fulfilment ability.",
      ],
    }));
  });

  r.get("/orgs/:orgId/activity", requireOrgPermission(prisma, "audit.read"), async (req, res) => {
    const q = validate(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const rows = await prisma.auditEvent.findMany({ where: { orgId: getScope(res).orgId }, orderBy: { createdAt: "desc" }, take: q.limit, select: { id: true, event: true, objectType: true, objectId: true, actorUserId: true, createdAt: true } });
    res.json(ser({ events: rows }));
  });

  return r;
}
export type { Prisma };
