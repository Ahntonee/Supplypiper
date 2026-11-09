import type { ProcurementRequest, Quote, QuoteVersion } from "@prisma/client";
import type { Request } from "express";
import { z } from "zod";
import {
  formatMinor, formatQuantity, money, parseMajorToMinor, quantity as makeQuantity,
  type Charge, type ExclusionReason, type QuoteVersionInput, type RequestInput, type UnitCode,
} from "@supplypiper/domain";
import { ApiError } from "./errors";
import type { Tx } from "./helpers";

export const uuid = z.string().uuid();
export const majorMoney = z.string().regex(/^\d+(\.\d{1,2})?$/, "Use a plain amount like 12000.00");
export const qtyString = z.string().regex(/^\d+(\.\d{1,6})?$/, "Use a plain number like 40 or 2.5");
export const unitEnum = z.enum(["mL", "L", "g", "kg", "each"]);
export const ianaTz = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}, "Unknown timezone");
export const isoWithOffset = z.string().datetime({ offset: true });

export function param(req: Request, key: string): string {
  const v = uuid.safeParse(req.params[key]);
  if (!v.success) throw new ApiError(404, "NOT_FOUND", "Not found");
  return v.data;
}

export function positiveQuantity(value: string, unit: UnitCode) {
  const q = makeQuantity(value, unit);
  if (q.scaled <= 0n) throw new ApiError(400, "VALIDATION_FAILED", "Quantity must be greater than zero", { quantity: "Must be greater than zero" });
  return q;
}

export const minorOf = (major: string): bigint => parseMajorToMinor(major, 2);

export function parseCharges(json: unknown): Charge[] {
  return (json as Array<{ kind: Charge["kind"]; label: string; amountMinor: string | null; mandatory: boolean }>).map((c) => ({
    kind: c.kind, label: c.label, mandatory: c.mandatory, amountMinor: c.amountMinor === null ? null : BigInt(c.amountMinor),
  }));
}

export function requestInput(r: ProcurementRequest): RequestInput {
  return {
    category: r.category, required: { scaled: r.quantityScaled, unit: r.unit as UnitCode },
    currency: r.currency, budgetMinor: r.budgetMinor, deliverBy: r.deliverByUtc,
  };
}

export function quoteInput(qv: QuoteVersion, quote: Pick<Quote, "supplierOrgId">): QuoteVersionInput {
  return {
    quoteVersionId: qv.id, supplierOrgId: quote.supplierOrgId, version: qv.version, source: qv.source,
    currency: qv.currency, category: qv.category, offered: { scaled: qv.offeredScaled, unit: qv.offeredUnit as UnitCode },
    unitPriceMinor: qv.unitPriceMinor, priceUnit: qv.priceUnit as UnitCode, goodsTotalMinor: qv.goodsTotalMinor,
    charges: parseCharges(qv.charges), validUntil: qv.validUntil, deliveryPromisedBy: qv.deliveryPromisedBy,
    paymentTerms: qv.paymentTerms, deliversToArea: qv.deliversToArea, lastUpdatedAt: qv.submittedAt ?? qv.validUntil,
    verification: null, // agent-sourced quotes are not accepted yet, so no verification observation exists
  };
}

/** The latest SUBMITTED version of each live quote. Older versions are superseded and never compared. */
export async function latestSubmitted(tx: Tx, requestId: string): Promise<Array<{ quote: Quote; qv: QuoteVersion }>> {
  const quotes = await tx.quote.findMany({
    where: { requestId, state: "submitted" },
    include: { versions: { where: { submittedAt: { not: null } }, orderBy: { version: "desc" }, take: 1 } },
  });
  return quotes.flatMap((q) => (q.versions[0] ? [{ quote: q, qv: q.versions[0] }] : []));
}

export const REASON_TEXT: Record<ExclusionReason, string> = {
  CATEGORY_MISMATCH: "The quote is for a different product category than requested.",
  CURRENCY_MISMATCH: "The quote is in a different currency than the request.",
  INCOMPATIBLE_UNITS: "The quote's units cannot be compared with the request without guessing a conversion.",
  INSUFFICIENT_QUANTITY: "The supplier offered less than the quantity requested.",
  OUTSIDE_DELIVERY_AREA: "The supplier did not confirm delivery to this area.",
  DELIVERY_PROMISE_MISSING: "The supplier gave no delivery commitment.",
  MISSED_DEADLINE: "The supplier's promised delivery is after your deadline.",
  EXPIRED: "The quote has expired.",
  INCOMPLETE_TOTAL: "A delivery or tax charge is missing or unknown, so the landed total cannot be calculated.",
  ARITHMETIC_MISMATCH: "The stated unit price and goods total disagree.",
  OVER_BUDGET: "The landed total is above your maximum budget.",
  MANUAL_LANE_NOT_PERMITTED: "This quote was entered by a person and the request does not allow manually submitted quotes.",
  VERIFICATION_MISSING: "No agent verification result exists for this agent quote.",
  VERIFICATION_NOT_VERIFIED: "The agent identity check did not succeed.",
  VERIFICATION_STALE: "The agent identity check is older than the freshness policy.",
  AUTHORITY_NOT_BOUND: "The supplier organisation has not authorised this agent to quote for it.",
};

export function fmtMoney(minor: bigint, currency: string): string {
  return formatMinor(money(minor, currency));
}
export { formatQuantity };
