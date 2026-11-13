import { areCompatible, convert, formatMinor, money, QUANTITY_SCALE, UnitError, type Charge, type Quantity, type UnitCode } from "@supplypiper/domain";

/**
 * The supplier's quote agent is a rule engine over the supplier's own catalogue and settings. No language model sets, adjusts or
 * explains a price, so nothing a buyer writes can change what it quotes. It refuses rather than guesses.
 */
export interface AgentRules { markupBps: number; validityHours: number; deliveryLeadHours: number; deliveryChargeMinor: bigint; taxBps: number }

export interface PlanInput {
  rules: AgentRules; allowedProductIds: string[]; now: Date;
  request: { category: string; quantityScaled: bigint; unit: UnitCode; deliverByUtc: Date; destinationArea: string };
  profile: { areaCode: string };
  products: Array<{ id: string; category: string; unit: UnitCode; unitPriceMinor: bigint; currency: string; stock: { availableScaled: bigint; reservedScaled: bigint } | null }>;
}

export type Refusal =
  | "NO_ALLOWED_PRODUCT" | "NO_MATCHING_PRODUCT" | "UNITS_NOT_COMPARABLE" | "NO_STOCK_STATEMENT" | "INSUFFICIENT_DECLARED_STOCK"
  | "OUTSIDE_DELIVERY_AREA" | "DELIVERY_AFTER_DEADLINE";

export const REFUSAL_TEXT: Record<Refusal, string> = {
  NO_ALLOWED_PRODUCT: "None of the products your quote agent is allowed to use are in your catalogue.",
  NO_MATCHING_PRODUCT: "None of your allowed products match the requested item.",
  UNITS_NOT_COMPARABLE: "The requested unit cannot be compared with your product's unit without guessing a conversion.",
  NO_STOCK_STATEMENT: "You have not declared any stock for the matching product.",
  INSUFFICIENT_DECLARED_STOCK: "Your declared available stock does not cover the requested quantity.",
  OUTSIDE_DELIVERY_AREA: "The delivery area is not the area you deliver to.",
  DELIVERY_AFTER_DEADLINE: "Your delivery lead time would miss the buyer's deadline.",
};

export interface PlannedQuote {
  productId: string; offered: Quantity; unitPriceMinor: bigint; priceUnit: UnitCode; goodsTotalMinor: bigint; currency: string;
  charges: Charge[]; validUntil: Date; deliveryPromisedBy: Date; report: string[];
}
export type Plan = { ok: true; quote: PlannedQuote } | { ok: false; refusals: Refusal[] };

const HOUR = 3_600_000;
const roundDiv = (num: bigint, den: bigint) => (num + den / 2n) / den; // half up, non-negative inputs

export function planAgentQuote(i: PlanInput): Plan {
  const refusals: Refusal[] = [];
  if (i.profile.areaCode.trim().toLowerCase() !== i.request.destinationArea.trim().toLowerCase()) refusals.push("OUTSIDE_DELIVERY_AREA");
  const promised = new Date(i.now.getTime() + i.rules.deliveryLeadHours * HOUR);
  if (promised.getTime() > i.request.deliverByUtc.getTime()) refusals.push("DELIVERY_AFTER_DEADLINE");

  const allowed = i.products.filter((p) => i.allowedProductIds.includes(p.id));
  if (allowed.length === 0) return { ok: false, refusals: [...refusals, "NO_ALLOWED_PRODUCT"] };
  const matching = allowed.filter((p) => p.category === i.request.category);
  if (matching.length === 0) return { ok: false, refusals: [...refusals, "NO_MATCHING_PRODUCT"] };
  const comparable = matching.filter((p) => areCompatible(p.unit, i.request.unit));
  if (comparable.length === 0) return { ok: false, refusals: [...refusals, "UNITS_NOT_COMPARABLE"] };

  // Cheapest comparable product first; ties broken by id so the choice is deterministic.
  const ordered = [...comparable].sort((a, b) => (a.unitPriceMinor < b.unitPriceMinor ? -1 : a.unitPriceMinor > b.unitPriceMinor ? 1 : a.id.localeCompare(b.id)));
  let chosen: (typeof ordered)[number] | null = null; let inProductUnit: Quantity | null = null; let stockReason: Refusal | null = null;
  for (const p of ordered) {
    let need: Quantity;
    try { need = convert({ scaled: i.request.quantityScaled, unit: i.request.unit }, p.unit); }
    catch (e) { if (e instanceof UnitError) { stockReason ??= "UNITS_NOT_COMPARABLE"; continue; } throw e; }
    if (!p.stock) { stockReason ??= "NO_STOCK_STATEMENT"; continue; }
    if (p.stock.availableScaled - p.stock.reservedScaled < need.scaled) { stockReason = "INSUFFICIENT_DECLARED_STOCK"; continue; }
    chosen = p; inProductUnit = need; break;
  }
  if (!chosen || !inProductUnit) return { ok: false, refusals: [...refusals, stockReason ?? "INSUFFICIENT_DECLARED_STOCK"] };
  if (refusals.length) return { ok: false, refusals };

  const unitPrice = roundDiv(chosen.unitPriceMinor * BigInt(10_000 + i.rules.markupBps), 10_000n);
  const goods = roundDiv(unitPrice * inProductUnit.scaled, QUANTITY_SCALE);
  const tax = roundDiv(goods * BigInt(i.rules.taxBps), 10_000n);
  const cur = chosen.currency;
  const m = (v: bigint) => formatMinor(money(v, cur));
  return {
    ok: true,
    quote: {
      productId: chosen.id, offered: { scaled: i.request.quantityScaled, unit: i.request.unit }, unitPriceMinor: unitPrice, priceUnit: chosen.unit, goodsTotalMinor: goods, currency: cur,
      charges: [
        { kind: "delivery", label: "Delivery", amountMinor: i.rules.deliveryChargeMinor, mandatory: true },
        { kind: "tax", label: "Tax", amountMinor: tax, mandatory: true }, // stated explicitly even when zero
      ],
      validUntil: new Date(i.now.getTime() + i.rules.validityHours * HOUR), deliveryPromisedBy: promised,
      report: [
        `Catalogue price ${m(chosen.unitPriceMinor)} per ${chosen.unit}, markup ${(i.rules.markupBps / 100).toFixed(2)}% gives ${m(unitPrice)} per ${chosen.unit}`,
        `Goods total ${m(goods)} for the requested quantity`,
        `Delivery ${m(i.rules.deliveryChargeMinor)} and tax ${m(tax)} (${(i.rules.taxBps / 100).toFixed(2)}%) stated explicitly`,
        `Valid for ${i.rules.validityHours} h; delivery promised ${i.rules.deliveryLeadHours} h from now, inside the buyer's deadline`,
        `Stock: declared available covers the quantity (a statement by you, reserved only if the order is accepted)`,
      ],
    },
  };
}
