import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import {
  assertTransition, can, checkApprovalForCommit, compareQuotes, convert, landedTotal, RFQ_TRANSITIONS, UnitError,
  type ApprovalBinding, type ComparisonResult, type OrgRole, type RfqState, type SortCriterion, type UnitCode,
} from "@supplypiper/domain";
import { getAuth, requireSession } from "./auth";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { audit, enqueueEmail, validate, type Tx } from "./helpers";
import {
  fmtMoney, ianaTz, isoWithOffset, latestSubmitted, majorMoney, minorOf, param, positiveQuantity, qtyString,
  quoteInput, REASON_TEXT, requestInput, unitEnum, uuid,
} from "./loaders";
import { getScope, requireOrgPermission } from "./orgs";
import { randomToken, sha256Base64 } from "./security";
import { ser } from "./serialize";

const INTENT_TTL_MS = 15 * 60_000;
const COLLECTING: RfqState[] = ["collecting", "ready_for_comparison"];

const requestBody = z.object({
  category: z.string().trim().min(1).max(60), quantity: qtyString, unit: unitEnum,
  budget: majorMoney, currency: z.literal("NGN").default("NGN"),
  deliverBy: isoWithOffset, deliverTz: ianaTz,
  destinationArea: z.string().trim().min(1).max(80), destinationAddress: z.string().trim().min(1).max(300),
  allowManualLane: z.boolean().default(false),
});

const quoteBody = z.object({
  source: z.enum(["human", "supplier_agent"]).default("human"),
  productId: uuid.optional(), category: z.string().trim().min(1).max(60),
  offeredQuantity: qtyString, offeredUnit: unitEnum, unitPrice: majorMoney, priceUnit: unitEnum, goodsTotal: majorMoney,
  charges: z.array(z.object({
    kind: z.enum(["delivery", "tax", "fee"]), label: z.string().trim().min(1).max(80),
    amount: majorMoney.nullable(), mandatory: z.boolean(),
  })).max(20),
  validUntil: isoWithOffset, deliveryPromisedBy: isoWithOffset.optional(), deliveryTz: ianaTz.optional(),
  paymentTerms: z.string().trim().max(200).optional(), deliversToArea: z.boolean(), submit: z.boolean().default(false),
});

const hashDestination = (area: string, address: string) => sha256Base64(`${area}\n${address}`);

async function emailsFor(tx: Tx, orgId: string, roles: OrgRole[]): Promise<string[]> {
  const ms = await tx.membership.findMany({ where: { orgId, role: { in: roles } }, include: { user: true } });
  return [...new Set(ms.map((m) => m.user.email))];
}

export function requestsRouter(prisma: PrismaClient, config: AppConfig): Router {
  const r = Router();
  r.use(requireSession);

  const ownRequest = async (orgId: string, id: string) => {
    const row = await prisma.procurementRequest.findFirst({ where: { id, buyerOrgId: orgId } });
    if (!row) throw new ApiError(404, "NOT_FOUND", "Request not found");
    return row;
  };

  /** Compare latest submitted versions under the request's own policy. Pure domain calculation. */
  async function runComparison(tx: Tx, request: Awaited<ReturnType<typeof ownRequest>>, sortedBy: SortCriterion) {
    const rows = await latestSubmitted(tx, request.id);
    const inputs = rows.map(({ quote, qv }) => quoteInput(qv, quote));
    const completedRows = await tx.order.groupBy({ by: ["supplierOrgId"], where: { state: "completed", supplierOrgId: { in: inputs.map((i) => i.supplierOrgId) } }, _count: true });
    const result = compareQuotes(
      requestInput(request), inputs,
      { now: new Date(), allowManualLane: request.allowManualLane, verificationFreshnessMs: config.verificationFreshnessMs },
      sortedBy, new Map(completedRows.map((c) => [c.supplierOrgId, c._count])),
    );
    return { rows, inputs, result };
  }

  async function presentComparison(request: Awaited<ReturnType<typeof ownRequest>>, result: ComparisonResult, rows: Awaited<ReturnType<typeof latestSubmitted>>) {
    const orgs = await prisma.organisation.findMany({ where: { id: { in: rows.map((x) => x.quote.supplierOrgId) } } });
    const name = new Map(orgs.map((o) => [o.id, o.name]));
    const profiles = await prisma.supplierProfile.findMany({ where: { orgId: { in: orgs.map((o) => o.id) } } });
    void profiles;
    const offer = (o: ComparisonResult["lanes"]["manual"][number]) => ({
      rank: o.rank, quoteVersionId: o.quoteVersionId, version: o.version, supplierOrgId: o.supplierOrgId,
      supplierName: name.get(o.supplierOrgId), lane: o.lane,
      source: o.source === "human" ? "Submitted by a person at the supplier (supplier statement)" : "Supplier agent (supplier statement)",
      goodsTotal: fmtMoney(o.goods.minor, o.goods.currency), landedTotal: fmtMoney(o.landed.minor, o.landed.currency),
      landedTotalMinor: o.landed.minor.toString(), currency: o.landed.currency,
      charges: o.charges.map((c) => ({ kind: c.kind, label: c.label, amount: c.amountMinor === null ? "Unknown" : fmtMoney(c.amountMinor, o.landed.currency), mandatory: c.mandatory })),
      deliveryPromisedBy: o.deliveryPromisedBy, paymentTerms: o.paymentTerms ?? "Not stated",
      lastUpdatedAt: o.lastUpdatedAt, completedOrders: o.completedOrders,
      verification: o.lane === "manual" ? "Manual quote: no agent verification applies and none is inherited" : "See agent evidence",
      whyThisMatches: [
        `Category and units compatible with your request`, `Quantity offered covers ${request.quantityScaled / 1_000_000n} ${request.unit}`,
        `Promised delivery is on or before your deadline`, `Landed total ${fmtMoney(o.landed.minor, o.landed.currency)} is within your budget`,
        `Ranked ${result.sortedBy === "landed_cost" ? "by landed cost" : "by earliest promised delivery"} within its lane (calculation ${result.calculationVersion})`,
      ],
    });
    return {
      calculationVersion: result.calculationVersion, sortedBy: result.sortedBy, noEligibleOffers: result.noEligibleOffers,
      generatedBy: "SupplyPiper deterministic rules. Not an AI summary. 'Best match' means best under the displayed criteria only.",
      lanes: { verified_agent: result.lanes.verified_agent.map(offer), manual: result.lanes.manual.map(offer) },
      excluded: result.excluded.map((e) => ({
        quoteVersionId: e.quoteVersionId, supplierName: name.get(rows.find((x) => x.qv.id === e.quoteVersionId)?.quote.supplierOrgId ?? ""),
        reasons: e.reasons.map((code) => ({ code, text: REASON_TEXT[code] })),
      })),
      nextSteps: result.noEligibleOffers ? "No offer qualifies. You can revise the request or invite more suppliers." : undefined,
    };
  }

  // ---------- buyer: requests ----------
  r.post("/orgs/:orgId/requests", requireOrgPermission(prisma, "request.create"), async (req, res) => {
    const b = validate(requestBody, req.body);
    const s = getScope(res);
    const qty = positiveQuantity(b.quantity, b.unit);
    const row = await prisma.$transaction(async (tx) => {
      const x = await tx.procurementRequest.create({
        data: {
          buyerOrgId: s.orgId, environment: config.mode, category: b.category, quantityScaled: qty.scaled, unit: b.unit,
          budgetMinor: minorOf(b.budget), currency: b.currency, deliverByUtc: new Date(b.deliverBy), deliverTz: b.deliverTz,
          destinationArea: b.destinationArea, destinationAddress: b.destinationAddress,
          destinationHash: hashDestination(b.destinationArea, b.destinationAddress), allowManualLane: b.allowManualLane,
        },
      });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "request.drafted", objectType: "ProcurementRequest", objectId: x.id });
      return x;
    });
    res.status(201).json(ser(row));
  });

  r.put("/orgs/:orgId/requests/:id", requireOrgPermission(prisma, "request.create"), async (req, res) => {
    const b = validate(requestBody, req.body);
    const s = getScope(res);
    const cur = await ownRequest(s.orgId, param(req, "id"));
    const qty = positiveQuantity(b.quantity, b.unit);
    const claimed = await prisma.procurementRequest.updateMany({
      where: { id: cur.id, state: "draft", version: cur.version },
      data: {
        version: { increment: 1 }, category: b.category, quantityScaled: qty.scaled, unit: b.unit, budgetMinor: minorOf(b.budget),
        deliverByUtc: new Date(b.deliverBy), deliverTz: b.deliverTz, destinationArea: b.destinationArea,
        destinationAddress: b.destinationAddress, destinationHash: hashDestination(b.destinationArea, b.destinationAddress),
        allowManualLane: b.allowManualLane,
      },
    });
    if (claimed.count !== 1) throw new ApiError(409, "REQUEST_NOT_EDITABLE", "Only an unchanged draft can be edited. Published requests are fixed; create a new one to change terms.");
    res.json(ser(await ownRequest(s.orgId, cur.id)));
  });

  r.get("/orgs/:orgId/requests", requireOrgPermission(prisma, "order.view"), async (_req, res) => {
    const rows = await prisma.procurementRequest.findMany({ where: { buyerOrgId: getScope(res).orgId }, orderBy: { createdAt: "desc" }, take: 100 });
    res.json(ser({ requests: rows }));
  });

  r.get("/orgs/:orgId/requests/:id", requireOrgPermission(prisma, "order.view"), async (req, res) => {
    const s = getScope(res);
    const request = await ownRequest(s.orgId, param(req, "id"));
    const [recipients, rows, timeline] = await Promise.all([
      prisma.requestRecipient.findMany({ where: { requestId: request.id } }),
      latestSubmitted(prisma, request.id),
      prisma.auditEvent.findMany({ where: { objectId: request.id }, orderBy: { createdAt: "asc" }, select: { event: true, createdAt: true, actorUserId: true } }),
    ]);
    const orgs = await prisma.organisation.findMany({ where: { id: { in: recipients.map((x) => x.supplierOrgId) } } });
    const responded = new Set(rows.map((x) => x.quote.supplierOrgId));
    res.json(ser({
      request,
      recipients: recipients.map((x) => ({ supplierOrgId: x.supplierOrgId, name: orgs.find((o) => o.id === x.supplierOrgId)?.name, status: responded.has(x.supplierOrgId) ? "responded" : "pending response" })),
      quotesReceived: rows.length, timeline,
    }));
  });

  r.post("/orgs/:orgId/requests/:id/publish", requireOrgPermission(prisma, "request.publish"), async (req, res) => {
    const b = validate(z.object({ supplierOrgIds: z.array(uuid).min(1).max(20), responseDeadline: isoWithOffset, confirmShare: z.literal(true, { message: "Confirm that the destination and quantity are shared with the selected suppliers" }) }), req.body);
    const s = getScope(res);
    const request = await ownRequest(s.orgId, param(req, "id"));
    const deadline = new Date(b.responseDeadline);
    if (deadline <= new Date() || deadline > request.deliverByUtc) throw new ApiError(400, "VALIDATION_FAILED", "Response deadline must be in the future and before the delivery deadline", { responseDeadline: "Out of range" });
    const ids = [...new Set(b.supplierOrgIds)];
    const suppliers = await prisma.organisation.findMany({ where: { id: { in: ids }, environment: config.mode, capabilities: { has: "supplier" }, supplier: { isNot: null } } });
    if (suppliers.length !== ids.length || ids.includes(s.orgId)) throw new ApiError(422, "INVALID_RECIPIENTS", "Every invited supplier must be a different organisation with a supplier profile in this environment");
    assertTransitionOr409(request.state, "published");
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.procurementRequest.updateMany({ where: { id: request.id, state: "draft", version: request.version }, data: { state: "published", responseDeadline: deadline } });
      if (claimed.count !== 1) throw new ApiError(409, "REQUEST_CHANGED", "The request changed. Review it again before publishing.");
      await tx.requestRecipient.createMany({ data: ids.map((supplierOrgId) => ({ requestId: request.id, supplierOrgId })) });
      for (const sid of ids) for (const to of await emailsFor(tx, sid, ["owner", "supplier_manager"])) await enqueueEmail(tx, to, "rfq_invited", { requestId: request.id });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "request.published", objectType: "ProcurementRequest", objectId: request.id, payload: { recipients: ids } });
    });
    res.json(ser(await ownRequest(s.orgId, request.id)));
  });

  r.post("/orgs/:orgId/requests/:id/cancel", requireOrgPermission(prisma, "request.publish"), async (req, res) => {
    const s = getScope(res);
    const request = await ownRequest(s.orgId, param(req, "id"));
    assertTransitionOr409(request.state, "cancelled");
    await prisma.procurementRequest.update({ where: { id: request.id }, data: { state: "cancelled" } });
    await audit(prisma, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "request.cancelled", objectType: "ProcurementRequest", objectId: request.id });
    res.json({ state: "cancelled" });
  });

  r.post("/orgs/:orgId/requests/:id/ready-for-comparison", requireOrgPermission(prisma, "request.publish"), async (req, res) => {
    const s = getScope(res);
    const request = await ownRequest(s.orgId, param(req, "id"));
    assertTransitionOr409(request.state, "ready_for_comparison");
    await prisma.procurementRequest.update({ where: { id: request.id }, data: { state: "ready_for_comparison" } });
    await audit(prisma, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "request.ready_for_comparison", objectType: "ProcurementRequest", objectId: request.id });
    res.json({ state: "ready_for_comparison" });
  });

  // ---------- supplier: inbox and quotes ----------
  const sharedRequest = (x: { id: string; category: string; quantityScaled: bigint; unit: string; deliverByUtc: Date; deliverTz: string; destinationArea: string; destinationAddress: string; responseDeadline: Date | null; state: string; buyerOrgId: string }, buyerName: string) => ({
    id: x.id, buyer: buyerName, buyerNameIsClaimed: true, category: x.category, quantityScaled: x.quantityScaled, unit: x.unit,
    deliverBy: x.deliverByUtc, deliverTz: x.deliverTz, destinationArea: x.destinationArea, destinationAddress: x.destinationAddress,
    responseDeadline: x.responseDeadline, state: x.state, // buyer budget and other suppliers' quotes are never included
  });

  r.get("/orgs/:orgId/inbox", requireOrgPermission(prisma, "catalogue.view"), async (_req, res) => {
    const s = getScope(res);
    const recs = await prisma.requestRecipient.findMany({
      where: { supplierOrgId: s.orgId, request: { state: { in: ["published", "collecting", "ready_for_comparison", "selected"] } } },
      include: { request: true }, orderBy: { invitedAt: "desc" },
    });
    const buyers = await prisma.organisation.findMany({ where: { id: { in: recs.map((x) => x.request.buyerOrgId) } } });
    const mine = await prisma.quote.findMany({ where: { supplierOrgId: s.orgId, requestId: { in: recs.map((x) => x.requestId) } } });
    res.json(ser({
      requests: recs.map((x) => ({ ...sharedRequest(x.request, buyers.find((b) => b.id === x.request.buyerOrgId)?.name ?? ""), myQuoteState: mine.find((q) => q.requestId === x.requestId)?.state ?? "no quote yet" })),
    }));
  });

  async function invitedOpenRequest(tx: Tx, orgId: string, requestId: string) {
    const rec = await tx.requestRecipient.findUnique({ where: { requestId_supplierOrgId: { requestId, supplierOrgId: orgId } }, include: { request: true } });
    if (!rec) throw new ApiError(404, "NOT_FOUND", "Request not found");
    const q = rec.request;
    if (!["published", "collecting"].includes(q.state)) throw new ApiError(409, "REQUEST_CLOSED", "This request is no longer accepting quotes");
    if (q.responseDeadline && q.responseDeadline <= new Date()) throw new ApiError(409, "RESPONSE_DEADLINE_PASSED", "The response deadline has passed");
    return q;
  }

  r.post("/orgs/:orgId/requests/:requestId/quotes", requireOrgPermission(prisma, "quote.draft"), async (req, res) => {
    const b = validate(quoteBody, req.body);
    const s = getScope(res);
    const user = getAuth(res).user;
    if (b.source === "supplier_agent") throw new ApiError(409, "AGENT_QUOTING_NOT_AVAILABLE", "Supplier agent quoting is not available yet. Submit a quote as a person.");
    if (b.submit && !can(s.roles, s.capabilities, "quote.submit")) throw new ApiError(403, "FORBIDDEN", "Your role can save drafts but cannot submit quotes");
    if (b.submit && !b.deliveryPromisedBy) throw new ApiError(400, "VALIDATION_FAILED", "A delivery commitment is required to submit", { deliveryPromisedBy: "Required to submit" });
    const offered = positiveQuantity(b.offeredQuantity, b.offeredUnit);
    const validUntil = new Date(b.validUntil);
    if (validUntil <= new Date()) throw new ApiError(400, "VALIDATION_FAILED", "Quote validity must be in the future", { validUntil: "Must be in the future" });
    const requestId = param(req, "requestId");
    const out = await prisma.$transaction(async (tx) => {
      await invitedOpenRequest(tx, s.orgId, requestId);
      if (b.productId) {
        const p = await tx.product.findFirst({ where: { id: b.productId, supplierOrgId: s.orgId } });
        if (!p) throw new ApiError(404, "NOT_FOUND", "Product not found");
        if (p.category !== b.category) throw new ApiError(400, "VALIDATION_FAILED", "Quote category must match the product category", { category: "Does not match product" });
      }
      const quote = await tx.quote.upsert({ where: { requestId_supplierOrgId: { requestId, supplierOrgId: s.orgId } }, create: { requestId, supplierOrgId: s.orgId }, update: {} });
      const last = await tx.quoteVersion.findFirst({ where: { quoteId: quote.id }, orderBy: { version: "desc" } });
      const qv = await tx.quoteVersion.create({
        data: {
          quoteId: quote.id, version: (last?.version ?? 0) + 1, source: "human", authorUserId: user.id, currency: "NGN",
          category: b.category, productId: b.productId, priceUnit: b.priceUnit, deliversToArea: b.deliversToArea,
          offeredScaled: offered.scaled, offeredUnit: b.offeredUnit, unitPriceMinor: minorOf(b.unitPrice), goodsTotalMinor: minorOf(b.goodsTotal),
          charges: b.charges.map((c) => ({ kind: c.kind, label: c.label, amountMinor: c.amount === null ? null : minorOf(c.amount).toString(), mandatory: c.mandatory })),
          validUntil, deliveryPromisedBy: b.deliveryPromisedBy ? new Date(b.deliveryPromisedBy) : null, deliveryTz: b.deliveryTz,
          paymentTerms: b.paymentTerms, submittedAt: b.submit ? new Date() : null,
        },
      });
      if (b.submit) await finishSubmit(tx, quote.id, requestId);
      await audit(tx, res, { orgId: s.orgId, actorUserId: user.id, event: b.submit ? "quote.submitted" : "quote.drafted", objectType: "QuoteVersion", objectId: qv.id, payload: { version: qv.version, requestId } });
      return qv;
    });
    res.status(201).json(ser(out));
  });

  async function finishSubmit(tx: Tx, quoteId: string, requestId: string) {
    await tx.quote.update({ where: { id: quoteId }, data: { state: "submitted" } });
    const rq = await tx.procurementRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (rq.state === "published") await tx.procurementRequest.update({ where: { id: requestId }, data: { state: "collecting" } });
  }

  r.post("/orgs/:orgId/quotes/:quoteId/versions/:versionId/submit", requireOrgPermission(prisma, "quote.submit"), async (req, res) => {
    const s = getScope(res);
    const out = await prisma.$transaction(async (tx) => {
      const qv = await tx.quoteVersion.findFirst({ where: { id: param(req, "versionId"), quoteId: param(req, "quoteId"), quote: { supplierOrgId: s.orgId } }, include: { quote: true } });
      if (!qv) throw new ApiError(404, "NOT_FOUND", "Quote not found");
      if (qv.submittedAt) throw new ApiError(409, "ALREADY_SUBMITTED", "This version is already submitted and cannot change");
      if (!qv.deliveryPromisedBy) throw new ApiError(400, "VALIDATION_FAILED", "A delivery commitment is required to submit", { deliveryPromisedBy: "Required" });
      if (qv.validUntil <= new Date()) throw new ApiError(400, "VALIDATION_FAILED", "Quote validity has passed", { validUntil: "Expired" });
      await invitedOpenRequest(tx, s.orgId, qv.quote.requestId);
      await tx.quoteVersion.update({ where: { id: qv.id }, data: { submittedAt: new Date() } });
      await finishSubmit(tx, qv.quoteId, qv.quote.requestId);
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "quote.submitted", objectType: "QuoteVersion", objectId: qv.id, payload: { version: qv.version } });
      return qv.id;
    });
    res.json({ quoteVersionId: out, status: "submitted" });
  });

  r.post("/orgs/:orgId/quotes/:quoteId/withdraw", requireOrgPermission(prisma, "quote.submit"), async (req, res) => {
    const s = getScope(res);
    const claimed = await prisma.quote.updateMany({ where: { id: param(req, "quoteId"), supplierOrgId: s.orgId, state: "submitted" }, data: { state: "withdrawn" } });
    if (claimed.count !== 1) throw new ApiError(409, "NOT_WITHDRAWABLE", "Only a submitted quote can be withdrawn");
    await audit(prisma, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "quote.withdrawn", objectType: "Quote", objectId: param(req, "quoteId") });
    res.json({ state: "withdrawn" });
  });

  r.get("/orgs/:orgId/requests/:requestId/quotes", requireOrgPermission(prisma, "catalogue.view"), async (req, res) => {
    const s = getScope(res);
    const q = await prisma.quote.findUnique({ where: { requestId_supplierOrgId: { requestId: param(req, "requestId"), supplierOrgId: s.orgId } }, include: { versions: { orderBy: { version: "asc" } } } });
    res.json(ser({ quote: q })); // only the caller's own quote is ever returned
  });

  // ---------- buyer: comparison ----------
  r.post("/orgs/:orgId/requests/:id/comparisons", requireOrgPermission(prisma, "order.view"), async (req, res) => {
    const b = validate(z.object({ sortedBy: z.enum(["landed_cost", "earliest_delivery"]).default("landed_cost") }), req.body ?? {});
    const s = getScope(res);
    const request = await ownRequest(s.orgId, param(req, "id"));
    if (!COLLECTING.includes(request.state)) throw new ApiError(409, "REQUEST_NOT_COLLECTING", "Quotes can be compared once the request has been published and is collecting responses");
    const { rows, inputs, result } = await runComparison(prisma, request, b.sortedBy);
    const run = await prisma.comparisonRun.create({
      data: { requestId: request.id, calculationVersion: result.calculationVersion, sortedBy: b.sortedBy, input: ser({ request: requestInput(request), quotes: inputs }) as Prisma.InputJsonValue, result: ser(result) as Prisma.InputJsonValue },
    });
    res.status(201).json({ id: run.id, ...(await presentComparison(request, result, rows)) } as never);
  });

  // ---------- buyer: approval ----------
  r.post("/orgs/:orgId/requests/:id/approval-intents", requireOrgPermission(prisma, "approval.approve"), async (req, res) => {
    const b = validate(z.object({ quoteVersionId: uuid, sortedBy: z.enum(["landed_cost", "earliest_delivery"]).default("landed_cost") }), req.body);
    const s = getScope(res);
    const request = await ownRequest(s.orgId, param(req, "id"));
    if (!COLLECTING.includes(request.state)) throw new ApiError(409, "REQUEST_NOT_COLLECTING", "This request is not open for approval");
    const { rows, inputs, result } = await runComparison(prisma, request, b.sortedBy);
    const offer = [...result.lanes.verified_agent, ...result.lanes.manual].find((o) => o.quoteVersionId === b.quoteVersionId);
    if (!offer) {
      const ex = result.excluded.find((e) => e.quoteVersionId === b.quoteVersionId);
      throw new ApiError(422, "NOT_ELIGIBLE", ex ? "This quote is not eligible for approval" : "Only the latest submitted version of a live quote can be approved",
        ex ? Object.fromEntries(ex.reasons.map((c) => [c, REASON_TEXT[c]])) : undefined);
    }
    const supplierName = (await prisma.organisation.findUniqueOrThrow({ where: { id: offer.supplierOrgId } })).name;
    const approval = await prisma.$transaction(async (tx) => {
      const run = await tx.comparisonRun.create({ data: { requestId: request.id, calculationVersion: result.calculationVersion, sortedBy: b.sortedBy, input: ser({ request: requestInput(request), quotes: inputs }) as Prisma.InputJsonValue, result: ser(result) as Prisma.InputJsonValue } });
      const a = await tx.approval.create({
        data: {
          requestId: request.id, comparisonRunId: run.id, buyerOrgId: s.orgId, approverUserId: getAuth(res).user.id, supplierOrgId: offer.supplierOrgId,
          quoteVersionId: offer.quoteVersionId, totalMinor: offer.landed.minor, currency: offer.landed.currency,
          destinationHash: request.destinationHash, requestVersion: request.version, intentId: randomToken(24), expiresAt: new Date(Date.now() + INTENT_TTL_MS),
        },
      });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "approval.intent_issued", objectType: "Approval", objectId: a.id, payload: { quoteVersionId: a.quoteVersionId, totalMinor: a.totalMinor.toString() } });
      return a;
    });
    void rows;
    res.status(201).json(ser({
      intentId: approval.intentId, expiresAt: approval.expiresAt, supplier: supplierName, quoteVersionId: offer.quoteVersionId, quoteVersion: offer.version,
      lane: offer.lane, quoteSource: "Submitted by a person at the supplier; no agent verification applies",
      totalMinor: approval.totalMinor, currency: approval.currency, total: fmtMoney(approval.totalMinor, approval.currency),
      deliveryPromisedBy: offer.deliveryPromisedBy, deliveryTo: `${request.destinationAddress}, ${request.destinationArea}`, paymentTerms: offer.paymentTerms ?? "Not stated",
      buttonLabel: `Approve order for ${fmtMoney(approval.totalMinor, approval.currency)}`,
      consequence: "Approving creates an order for this exact quote version and total. The supplier must still accept it. Acceptance is not proof of delivery.",
    }));
  });

  r.post("/orgs/:orgId/approvals/:intentId/confirm", requireOrgPermission(prisma, "approval.approve"), async (req, res) => {
    const b = validate(z.object({ expectedTotalMinor: z.string().regex(/^\d+$/) }), req.body);
    const s = getScope(res);
    const user = getAuth(res).user;
    const intentId = String(req.params.intentId);
    const approval = await prisma.approval.findFirst({ where: { intentId, buyerOrgId: s.orgId } });
    if (!approval) throw new ApiError(404, "NOT_FOUND", "Approval not found");
    if (approval.approverUserId !== user.id) throw new ApiError(403, "FORBIDDEN", "Only the person who reviewed this quote can confirm it");
    if (approval.totalMinor.toString() !== b.expectedTotalMinor) throw new ApiError(409, "TOTAL_MISMATCH", "The total you reviewed does not match this approval");
    const existing = async () => prisma.order.findUnique({ where: { approvalId: approval.id } });
    if (approval.consumedAt) {
      const o = await existing();
      if (o) return void res.status(200).json({ orderId: o.id, replay: true });
    }

    type Outcome = { kind: "created"; orderId: string } | { kind: "replay" } | { kind: "rejected"; reasons: string[] };
    const outcome: Outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
      const request = await tx.procurementRequest.findUniqueOrThrow({ where: { id: approval.requestId } });
      const quote = await tx.quote.findUnique({ where: { requestId_supplierOrgId: { requestId: request.id, supplierOrgId: approval.supplierOrgId } }, include: { versions: { where: { submittedAt: { not: null } }, orderBy: { version: "desc" }, take: 1 } } });
      const latest = quote?.versions[0];
      if (!quote || !latest) return { kind: "rejected", reasons: ["QUOTE_VERSION_CHANGED"] };
      const current = quoteInput(latest, quote);
      let stockOk = true;
      if (latest.productId) {
        const st = await tx.inventoryStatement.findFirst({ where: { productId: latest.productId }, orderBy: { statedAt: "desc" }, include: { product: true } });
        try {
          const need = convert({ scaled: latest.offeredScaled, unit: latest.offeredUnit as UnitCode }, st?.product.unit as UnitCode);
          stockOk = !!st && st.availableScaled - st.reservedScaled >= need.scaled;
        } catch (e) { if (e instanceof UnitError) stockOk = false; else throw e; }
      }
      const binding: ApprovalBinding = {
        buyerOrgId: approval.buyerOrgId, approverUserId: approval.approverUserId, supplierOrgId: approval.supplierOrgId, quoteVersionId: approval.quoteVersionId,
        totalMinor: approval.totalMinor, currency: approval.currency, destinationHash: approval.destinationHash, expiresAt: approval.expiresAt, requestVersion: approval.requestVersion,
      };
      const reasons: string[] = checkApprovalForCommit(binding, {
        now: new Date(), currentQuote: current, currentDestinationHash: request.destinationHash, currentRequestVersion: request.version,
        approverMayApprove: can(s.roles, s.capabilities, "approval.approve"), freshVerification: null,
        verificationFreshnessMs: config.verificationFreshnessMs, stockAvailable: stockOk,
      });
      if (quote.state === "withdrawn") reasons.push("QUOTE_WITHDRAWN");
      if (!COLLECTING.includes(request.state)) reasons.push("REQUEST_CHANGED");
      if (reasons.length) return { kind: "rejected", reasons };

      const claimed = await tx.approval.updateMany({ where: { id: approval.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (claimed.count !== 1) return { kind: "replay" }; // another tab/retry won the race
      const run = approval.comparisonRunId ? await tx.comparisonRun.findUnique({ where: { id: approval.comparisonRunId } }) : null;
      let order;
      try {
        order = await tx.order.create({
          data: {
            approvalId: approval.id, requestId: request.id, quoteVersionId: latest.id, buyerOrgId: s.orgId, supplierOrgId: approval.supplierOrgId,
            totalMinor: approval.totalMinor, currency: approval.currency,
            snapshot: ser({
              request: { id: request.id, category: request.category, quantityScaled: request.quantityScaled, unit: request.unit, deliverBy: request.deliverByUtc, deliverTz: request.deliverTz, destinationArea: request.destinationArea, destinationAddress: request.destinationAddress },
              quoteVersion: { id: latest.id, version: latest.version, source: latest.source, offeredScaled: latest.offeredScaled, offeredUnit: latest.offeredUnit, unitPriceMinor: latest.unitPriceMinor, priceUnit: latest.priceUnit, goodsTotalMinor: latest.goodsTotalMinor, charges: latest.charges, validUntil: latest.validUntil, deliveryPromisedBy: latest.deliveryPromisedBy, deliveryTz: latest.deliveryTz, paymentTerms: latest.paymentTerms, productId: latest.productId },
              landedTotalMinor: landedTotal(current)?.minor, calculationVersion: run?.calculationVersion, comparisonRunId: run?.id,
              approval: { id: approval.id, approverUserId: approval.approverUserId, approvedAt: new Date() },
              verification: "Manual lane: no agent identity verification applied",
            }) as Prisma.InputJsonValue,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ApiError(409, "ORDER_ALREADY_EXISTS", "A live order already exists for this request");
        throw e;
      }
      if (request.state === "collecting") await tx.procurementRequest.update({ where: { id: request.id }, data: { state: "ready_for_comparison" } });
      await tx.procurementRequest.update({ where: { id: request.id }, data: { state: "selected" } });
      for (const to of await emailsFor(tx, approval.supplierOrgId, ["owner", "supplier_manager"])) await enqueueEmail(tx, to, "order_created", { orderId: order.id });
      await audit(tx, res, { orgId: s.orgId, actorUserId: user.id, event: "order.created", objectType: "Order", objectId: order.id, payload: { approvalId: approval.id, totalMinor: approval.totalMinor.toString() } });
      return { kind: "created", orderId: order.id };
    });

    if (outcome.kind === "rejected") {
      await audit(prisma, res, { orgId: s.orgId, actorUserId: user.id, event: "approval.rejected", objectType: "Approval", objectId: approval.id, payload: { reasons: outcome.reasons } });
      throw new ApiError(409, "APPROVAL_REJECTED", "This approval can no longer be used because something changed. Review the current quote and approve again.", { reasons: outcome.reasons.join(",") });
    }
    if (outcome.kind === "replay") {
      const o = await existing();
      if (!o) throw new ApiError(409, "APPROVAL_IN_PROGRESS", "This approval is being processed. Refresh in a moment.");
      return void res.status(200).json({ orderId: o.id, replay: true });
    }
    res.status(201).json({ orderId: outcome.orderId, replay: false });
  });

  return r;
}

function assertTransitionOr409(from: RfqState, to: RfqState): void {
  try { assertTransition(RFQ_TRANSITIONS, from, to); } catch { throw new ApiError(409, "ILLEGAL_STATE", `A request in state "${from}" cannot move to "${to}"`); }
}
export { randomUUID };
