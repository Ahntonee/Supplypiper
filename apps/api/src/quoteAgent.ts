import { Router } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { can, type UnitCode } from "@supplypiper/domain";
import { authorityValid } from "./agentVerification";
import { getAuth, requireSession } from "./auth";
import { ApiError } from "./errors";
import { audit, validate } from "./helpers";
import { majorMoney, minorOf, param, uuid } from "./loaders";
import { getScope, requireOrgPermission } from "./orgs";
import { planAgentQuote, REFUSAL_TEXT } from "./quoteAgentRules";
import { assertAgentMayQuote, finishSubmit, invitedOpenRequest } from "./quoteFlow";
import { ser } from "./serialize";

const configBody = z.object({
  enabled: z.boolean(), agentId: uuid.nullable(),
  markupBps: z.number().int().min(-1000).max(5000), validityHours: z.number().int().min(1).max(168), deliveryLeadHours: z.number().int().min(1).max(336),
  deliveryCharge: majorMoney, taxBps: z.number().int().min(0).max(3000), allowedProductIds: z.array(uuid).max(50), requireHumanReview: z.boolean(),
});

export function quoteAgentRouter(prisma: PrismaClient): Router {
  const r = Router();
  r.use(requireSession);

  r.get("/orgs/:orgId/quote-agent", requireOrgPermission(prisma, "catalogue.view"), async (_req, res) => {
    const s = getScope(res);
    const [cfg, agents, products] = await Promise.all([
      prisma.quoteAgentConfig.findUnique({ where: { orgId: s.orgId } }),
      prisma.agentRegistration.findMany({ where: { orgId: s.orgId }, orderBy: { createdAt: "desc" } }),
      prisma.product.findMany({ where: { supplierOrgId: s.orgId }, select: { id: true, name: true, unit: true } }),
    ]);
    res.json(ser({
      config: cfg ?? { enabled: false, agentId: null, markupBps: 0, validityHours: 24, deliveryLeadHours: 24, deliveryChargeMinor: 0n, taxBps: 0, allowedProductIds: [], requireHumanReview: true },
      agents: agents.map((a) => ({ id: a.id, tokenAddress: a.tokenAddress, network: a.network, operatorType: a.operatorType, authorised: authorityValid(a) })),
      products,
      note: "Your quote agent follows these rules and your catalogue. No AI model sets or explains a price. It refuses rather than guesses, and by default you review every draft before it is submitted.",
    }));
  });

  r.put("/orgs/:orgId/quote-agent", requireOrgPermission(prisma, "catalogue.manage"), async (req, res) => {
    const b = validate(configBody, req.body);
    const s = getScope(res); const user = getAuth(res).user;
    if (!b.requireHumanReview && !can(s.roles, s.capabilities, "agent.authorise")) throw new ApiError(403, "FORBIDDEN", "Only the organisation owner can let the quote agent submit quotes without human review");
    if (b.enabled) await assertAgentMayQuote(prisma, b.agentId, s.orgId);
    else if (b.agentId) await assertAgentMayQuote(prisma, b.agentId, s.orgId).catch(() => { throw new ApiError(409, "AGENT_NOT_AUTHORISED", "Choose one of your own agents that your organisation has authorised"); });
    const owned = await prisma.product.count({ where: { supplierOrgId: s.orgId, id: { in: b.allowedProductIds } } });
    if (owned !== new Set(b.allowedProductIds).size) throw new ApiError(400, "VALIDATION_FAILED", "Some allowed products are not in your catalogue", { allowedProductIds: "Unknown product" });
    const data = { enabled: b.enabled, agentId: b.agentId, markupBps: b.markupBps, validityHours: b.validityHours, deliveryLeadHours: b.deliveryLeadHours, deliveryChargeMinor: minorOf(b.deliveryCharge), taxBps: b.taxBps, allowedProductIds: [...new Set(b.allowedProductIds)], requireHumanReview: b.requireHumanReview };
    const saved = await prisma.$transaction(async (tx) => {
      const row = await tx.quoteAgentConfig.upsert({ where: { orgId: s.orgId }, create: { orgId: s.orgId, ...data }, update: data });
      await audit(tx, res, { orgId: s.orgId, actorUserId: user.id, event: "quote_agent.configured", objectType: "QuoteAgentConfig", objectId: s.orgId, payload: { ...b, deliveryCharge: b.deliveryCharge } as unknown as Prisma.InputJsonValue });
      return row;
    });
    res.json(ser({ config: saved }));
  });

  /** Prepares a quote from the supplier's rules and catalogue. Always a draft unless the owner has switched human review off. */
  r.post("/orgs/:orgId/requests/:requestId/agent-draft", requireOrgPermission(prisma, "quote.draft"), async (req, res) => {
    const s = getScope(res); const user = getAuth(res).user; const requestId = param(req, "requestId");
    const cfg = await prisma.quoteAgentConfig.findUnique({ where: { orgId: s.orgId } });
    if (!cfg?.enabled) throw new ApiError(409, "QUOTE_AGENT_DISABLED", "Your quote agent is switched off. Turn it on in the quote agent settings.");
    await assertAgentMayQuote(prisma, cfg.agentId, s.orgId);
    const request = await invitedOpenRequest(prisma, s.orgId, requestId);
    const profile = await prisma.supplierProfile.findUnique({ where: { orgId: s.orgId } });
    if (!profile) throw new ApiError(409, "PROFILE_REQUIRED", "Create your supplier profile first");
    const products = await prisma.product.findMany({ where: { supplierOrgId: s.orgId }, include: { inventory: { orderBy: { statedAt: "desc" }, take: 1 } } });
    const plan = planAgentQuote({
      now: new Date(), allowedProductIds: cfg.allowedProductIds, profile: { areaCode: profile.areaCode },
      rules: { markupBps: cfg.markupBps, validityHours: cfg.validityHours, deliveryLeadHours: cfg.deliveryLeadHours, deliveryChargeMinor: cfg.deliveryChargeMinor, taxBps: cfg.taxBps },
      request: { category: request.category, quantityScaled: request.quantityScaled, unit: request.unit as UnitCode, deliverByUtc: request.deliverByUtc, destinationArea: request.destinationArea },
      products: products.map((p) => ({ id: p.id, category: p.category, unit: p.unit as UnitCode, unitPriceMinor: p.unitPriceMinor, currency: p.currency, stock: p.inventory[0] ? { availableScaled: p.inventory[0].availableScaled, reservedScaled: p.inventory[0].reservedScaled } : null })),
    });
    if (!plan.ok) {
      await audit(prisma, res, { orgId: s.orgId, actorUserId: user.id, event: "quote_agent.refused", objectType: "ProcurementRequest", objectId: requestId, payload: { reasons: plan.refusals } });
      throw new ApiError(409, "AGENT_REFUSED", "Your quote agent could not prepare a quote for this request. Nothing was drafted.", Object.fromEntries(plan.refusals.map((c) => [c, REFUSAL_TEXT[c]])));
    }
    const q = plan.quote;
    const autoSubmit = !cfg.requireHumanReview && can(s.roles, s.capabilities, "quote.submit");
    const qv = await prisma.$transaction(async (tx) => {
      await invitedOpenRequest(tx, s.orgId, requestId);
      const quote = await tx.quote.upsert({ where: { requestId_supplierOrgId: { requestId, supplierOrgId: s.orgId } }, create: { requestId, supplierOrgId: s.orgId }, update: {} });
      const last = await tx.quoteVersion.findFirst({ where: { quoteId: quote.id }, orderBy: { version: "desc" } });
      const v = await tx.quoteVersion.create({
        data: {
          quoteId: quote.id, version: (last?.version ?? 0) + 1, source: "supplier_agent", agentId: cfg.agentId, authorUserId: user.id, currency: q.currency, category: request.category,
          productId: q.productId, priceUnit: q.priceUnit, deliversToArea: true, offeredScaled: q.offered.scaled, offeredUnit: q.offered.unit, unitPriceMinor: q.unitPriceMinor, goodsTotalMinor: q.goodsTotalMinor,
          charges: q.charges.map((c) => ({ kind: c.kind, label: c.label, amountMinor: c.amountMinor === null ? null : c.amountMinor.toString(), mandatory: c.mandatory })),
          validUntil: q.validUntil, deliveryPromisedBy: q.deliveryPromisedBy, deliveryTz: request.deliverTz, paymentTerms: null, submittedAt: autoSubmit ? new Date() : null,
        },
      });
      if (autoSubmit) await finishSubmit(tx, quote.id, requestId);
      await audit(tx, res, {
        orgId: s.orgId, actorUserId: user.id, event: autoSubmit ? "quote_agent.submitted" : "quote_agent.drafted", objectType: "QuoteVersion", objectId: v.id,
        payload: { agentId: cfg.agentId, version: v.version, report: q.report, humanReview: !autoSubmit } as unknown as Prisma.InputJsonValue,
      });
      return v;
    });
    res.status(201).json(ser({
      draft: qv, submitted: autoSubmit, report: q.report,
      notice: autoSubmit
        ? "Submitted by your quote agent under the rules above, because the organisation owner switched human review off."
        : "Drafted by your quote agent from your rules and catalogue. No AI model set the price. Review it, then submit it yourself.",
    }));
  });

  return r;
}
