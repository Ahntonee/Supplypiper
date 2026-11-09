import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { requireSession, getAuth } from "./auth";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { audit, validate } from "./helpers";
import { majorMoney, minorOf, param, positiveQuantity, qtyString, unitEnum } from "./loaders";
import { getScope, requireOrgPermission } from "./orgs";
import { ser } from "./serialize";

export function catalogueRouter(prisma: PrismaClient, config: AppConfig): Router {
  const r = Router();
  r.use(requireSession);

  r.put("/orgs/:orgId/supplier-profile", requireOrgPermission(prisma, "catalogue.manage"), async (req, res) => {
    const body = validate(z.object({
      category: z.string().trim().min(1).max(60), areaCode: z.string().trim().min(1).max(60),
      claimedLegalName: z.string().trim().max(160).optional(), shareContact: z.boolean().default(false),
    }), req.body);
    const s = getScope(res);
    const p = await prisma.$transaction(async (tx) => {
      const row = await tx.supplierProfile.upsert({ where: { orgId: s.orgId }, create: { orgId: s.orgId, ...body }, update: body });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "supplier_profile.updated", objectType: "SupplierProfile", objectId: s.orgId });
      return row;
    });
    res.json(ser({ ...p, note: "Business details are claimed by the supplier and are not verified by SupplyPiper." }));
  });

  r.get("/orgs/:orgId/supplier-profile", requireOrgPermission(prisma, "catalogue.view"), async (_req, res) => {
    const p = await prisma.supplierProfile.findUnique({ where: { orgId: getScope(res).orgId } });
    if (!p) throw new ApiError(404, "NOT_FOUND", "No supplier profile yet");
    res.json(ser(p));
  });

  r.post("/orgs/:orgId/products", requireOrgPermission(prisma, "catalogue.manage"), async (req, res) => {
    const body = validate(z.object({
      name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60), unit: unitEnum,
      priceBasis: z.string().trim().min(1).max(120), unitPrice: majorMoney, currency: z.literal("NGN").default("NGN"),
      packSize: z.object({ quantity: qtyString, unit: unitEnum }).optional(),
    }), req.body);
    const s = getScope(res);
    if (!(await prisma.supplierProfile.findUnique({ where: { orgId: s.orgId } }))) {
      throw new ApiError(409, "PROFILE_REQUIRED", "Create your supplier profile before adding products");
    }
    const pack = body.packSize ? positiveQuantity(body.packSize.quantity, body.packSize.unit) : null;
    const p = await prisma.$transaction(async (tx) => {
      const row = await tx.product.create({
        data: {
          supplierOrgId: s.orgId, name: body.name, category: body.category, unit: body.unit, priceBasis: body.priceBasis,
          unitPriceMinor: minorOf(body.unitPrice), currency: body.currency, packSizeScaled: pack?.scaled, packSizeUnit: pack?.unit,
        },
      });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "product.created", objectType: "Product", objectId: row.id });
      return row;
    });
    res.status(201).json(ser(p));
  });

  r.get("/orgs/:orgId/products", requireOrgPermission(prisma, "catalogue.view"), async (_req, res) => {
    const products = await prisma.product.findMany({
      where: { supplierOrgId: getScope(res).orgId },
      include: { inventory: { orderBy: { statedAt: "desc" }, take: 1 } },
    });
    res.json(ser({
      products: products.map(({ inventory, ...p }) => ({
        ...p,
        stock: inventory[0]
          ? { statement: "Supplier-declared; not a guarantee until an order is accepted", availableScaled: inventory[0].availableScaled, reservedScaled: inventory[0].reservedScaled, statedAt: inventory[0].statedAt }
          : null,
      })),
    }));
  });

  r.post("/orgs/:orgId/products/:productId/inventory", requireOrgPermission(prisma, "catalogue.manage"), async (req, res) => {
    const body = validate(z.object({ available: qtyString }), req.body);
    const s = getScope(res);
    const product = await prisma.product.findFirst({ where: { id: param(req, "productId"), supplierOrgId: s.orgId } });
    if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found");
    const available = positiveQuantity(body.available, product.unit as never);
    const row = await prisma.$transaction(async (tx) => {
      const prev = await tx.inventoryStatement.findFirst({ where: { productId: product.id }, orderBy: { statedAt: "desc" } });
      const reserved = prev?.reservedScaled ?? 0n; // reservations carry over to the new statement
      if (available.scaled < reserved) throw new ApiError(409, "BELOW_RESERVED", "Available stock cannot be set below stock already reserved for accepted orders");
      const st = await tx.inventoryStatement.create({ data: { productId: product.id, availableScaled: available.scaled, reservedScaled: reserved } });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "inventory.stated", objectType: "InventoryStatement", objectId: st.id });
      return st;
    });
    res.status(201).json(ser(row));
  });

  /** Directory of real supplier profiles in the same environment. Prices are never shown here. */
  r.get("/suppliers", async (req, res) => {
    const q = validate(z.object({ category: z.string().max(60).optional(), area: z.string().max(60).optional() }), req.query);
    const profiles = await prisma.supplierProfile.findMany({
      where: { ...(q.category ? { category: q.category } : {}), ...(q.area ? { areaCode: q.area } : {}), org: { environment: config.mode } },
      include: { org: true, products: { include: { inventory: { orderBy: { statedAt: "desc" }, take: 1 } } } },
    });
    const completed = await prisma.order.groupBy({
      by: ["supplierOrgId"], where: { state: "completed", supplierOrgId: { in: profiles.map((p) => p.orgId) } }, _count: true,
    });
    const done = new Map(completed.map((c) => [c.supplierOrgId, c._count]));
    res.json(ser({
      suppliers: profiles.map((p) => {
        const stamps = p.products.flatMap((x) => x.inventory.map((i) => i.statedAt.getTime()));
        return {
          orgId: p.orgId, name: p.org.name, claimedLegalName: p.claimedLegalName, claimedBusinessDetails: true,
          category: p.category, areaCode: p.areaCode,
          lastInventoryUpdate: stamps.length ? new Date(Math.max(...stamps)) : null,
          completedOrders: done.get(p.orgId) ?? "No completed orders recorded",
          agentEvidence: "No agent identity check recorded",
        };
      }),
    }));
  });

  return r;
}
