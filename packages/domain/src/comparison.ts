import { addMoney, money, type Money } from "./money";
import { compareQuantity, convert, isUnitCode, QUANTITY_SCALE, UnitError, type Quantity, type UnitCode } from "./units";

export const CALCULATION_VERSION = "cmp-1";

export type VerificationStatus =
  | "verified" | "unverified" | "pending" | "revoked" | "stale" | "unavailable" | "invalid";

export interface VerificationObservation {
  status: VerificationStatus;
  network: "testnet" | "mainnet" | "demo";
  checkedAt: Date;
  /** Separate record: has an authorised org member bound this agent to the supplier org? */
  organisationAuthorityBound: boolean;
  simulated: boolean;
}

export type ChargeKind = "delivery" | "tax" | "fee";
export interface Charge {
  kind: ChargeKind;
  label: string;
  /** null = unknown. Zero must be stated explicitly as 0n. */
  amountMinor: bigint | null;
  mandatory: boolean;
}

export interface QuoteVersionInput {
  quoteVersionId: string;
  supplierOrgId: string;
  version: number;
  source: "supplier_agent" | "human";
  currency: string;
  category: string;
  offered: Quantity;
  /** Stated price per one `priceUnit`, in minor units. Informational; checked against goodsTotal. */
  unitPriceMinor: bigint;
  priceUnit: UnitCode;
  goodsTotalMinor: bigint;
  charges: Charge[];
  validUntil: Date;
  /** Supplier promise, as a UTC instant (the original timezone is kept in storage). */
  deliveryPromisedBy: Date | null;
  paymentTerms: string | null;
  deliversToArea: boolean;
  lastUpdatedAt: Date;
  verification: VerificationObservation | null;
}

export interface RequestInput {
  category: string;
  required: Quantity;
  currency: string;
  budgetMinor: bigint;
  deliverBy: Date;
}

export interface Policy {
  now: Date;
  allowManualLane: boolean;
  verificationFreshnessMs: number;
}

export type ExclusionReason =
  | "CATEGORY_MISMATCH" | "CURRENCY_MISMATCH" | "INCOMPATIBLE_UNITS" | "INSUFFICIENT_QUANTITY"
  | "OUTSIDE_DELIVERY_AREA" | "DELIVERY_PROMISE_MISSING" | "MISSED_DEADLINE" | "EXPIRED"
  | "INCOMPLETE_TOTAL" | "ARITHMETIC_MISMATCH" | "OVER_BUDGET"
  | "MANUAL_LANE_NOT_PERMITTED" | "VERIFICATION_MISSING" | "VERIFICATION_NOT_VERIFIED"
  | "VERIFICATION_STALE" | "AUTHORITY_NOT_BOUND";

export interface RankedOffer {
  rank: number;
  quoteVersionId: string;
  supplierOrgId: string;
  version: number;
  lane: "verified_agent" | "manual";
  landed: Money;
  goods: Money;
  charges: Charge[];
  deliveryPromisedBy: Date | null;
  paymentTerms: string | null;
  lastUpdatedAt: Date;
  source: QuoteVersionInput["source"];
  /** Always shown; never merged into a trust score. */
  completedOrders: "No completed orders recorded" | number;
}

export interface Exclusion {
  quoteVersionId: string;
  reasons: ExclusionReason[];
}

export interface ComparisonResult {
  calculationVersion: string;
  sortedBy: SortCriterion;
  lanes: { verified_agent: RankedOffer[]; manual: RankedOffer[] };
  excluded: Exclusion[];
  /** Plain statement; never AI-authored. */
  noEligibleOffers: boolean;
}

export type SortCriterion = "landed_cost" | "earliest_delivery";

/** Landed total or null when any mandatory charge is unknown / delivery or tax are unstated. */
export function landedTotal(q: Pick<QuoteVersionInput, "goodsTotalMinor" | "charges" | "currency">): Money | null {
  const hasDelivery = q.charges.some((c) => c.kind === "delivery");
  const hasTax = q.charges.some((c) => c.kind === "tax");
  if (!hasDelivery || !hasTax) return null;
  let total = money(q.goodsTotalMinor, q.currency);
  for (const c of q.charges) {
    if (c.amountMinor === null) {
      if (c.mandatory) return null;
      continue;
    }
    total = addMoney(total, money(c.amountMinor, q.currency));
  }
  return total;
}

/** unitPrice * quantity (in priceUnit) rounded half-up to a minor unit. */
function expectedGoods(q: QuoteVersionInput): bigint {
  const inPriceUnit = convert(q.offered, q.priceUnit);
  const num = q.unitPriceMinor * inPriceUnit.scaled;
  return (num + QUANTITY_SCALE / 2n) / QUANTITY_SCALE;
}

function evaluate(req: RequestInput, q: QuoteVersionInput, p: Policy): { reasons: ExclusionReason[]; landed: Money | null } {
  const r: ExclusionReason[] = [];
  if (q.category !== req.category) r.push("CATEGORY_MISMATCH");
  if (q.currency !== req.currency) r.push("CURRENCY_MISMATCH");

  if (!isUnitCode(q.offered.unit) || !isUnitCode(q.priceUnit)) {
    r.push("INCOMPATIBLE_UNITS");
  } else {
    try {
      if (compareQuantity(q.offered, req.required) < 0) r.push("INSUFFICIENT_QUANTITY");
      const diff = expectedGoods(q) - q.goodsTotalMinor;
      if (diff > 1n || diff < -1n) r.push("ARITHMETIC_MISMATCH");
    } catch (e) {
      if (e instanceof UnitError) r.push("INCOMPATIBLE_UNITS");
      else throw e;
    }
  }

  if (!q.deliversToArea) r.push("OUTSIDE_DELIVERY_AREA");
  if (q.deliveryPromisedBy === null) r.push("DELIVERY_PROMISE_MISSING");
  else if (q.deliveryPromisedBy.getTime() > req.deliverBy.getTime()) r.push("MISSED_DEADLINE");
  if (q.validUntil.getTime() <= p.now.getTime()) r.push("EXPIRED");

  const landed = q.currency === req.currency ? landedTotal(q) : null;
  if (landed === null) r.push("INCOMPLETE_TOTAL");
  else if (landed.minor > req.budgetMinor) r.push("OVER_BUDGET");

  if (q.source === "human") {
    if (!p.allowManualLane) r.push("MANUAL_LANE_NOT_PERMITTED");
  } else {
    const v = q.verification;
    if (!v) r.push("VERIFICATION_MISSING");
    else {
      if (v.status !== "verified") r.push("VERIFICATION_NOT_VERIFIED");
      else if (p.now.getTime() - v.checkedAt.getTime() > p.verificationFreshnessMs) r.push("VERIFICATION_STALE");
      if (!v.organisationAuthorityBound) r.push("AUTHORITY_NOT_BOUND");
    }
  }
  return { reasons: r, landed };
}

export function compareQuotes(
  req: RequestInput,
  quotes: readonly QuoteVersionInput[],
  policy: Policy,
  sortedBy: SortCriterion = "landed_cost",
  completedOrders: ReadonlyMap<string, number> = new Map(),
): ComparisonResult {
  const eligible: Array<{ q: QuoteVersionInput; landed: Money }> = [];
  const excluded: Exclusion[] = [];
  for (const q of quotes) {
    const { reasons, landed } = evaluate(req, q, policy);
    if (reasons.length === 0 && landed) eligible.push({ q, landed });
    else excluded.push({ quoteVersionId: q.quoteVersionId, reasons });
  }

  const cmp = (a: (typeof eligible)[number], b: (typeof eligible)[number]): number => {
    const byCost = a.landed.minor < b.landed.minor ? -1 : a.landed.minor > b.landed.minor ? 1 : 0;
    const ta = a.q.deliveryPromisedBy!.getTime();
    const tb = b.q.deliveryPromisedBy!.getTime();
    const byDate = ta - tb;
    const primary = sortedBy === "landed_cost" ? byCost || byDate : byDate || byCost;
    return primary || a.q.quoteVersionId.localeCompare(b.q.quoteVersionId); // deterministic tie-break
  };

  const build = (lane: "verified_agent" | "manual"): RankedOffer[] =>
    eligible
      .filter((e) => (lane === "manual") === (e.q.source === "human"))
      .sort(cmp)
      .map((e, i) => ({
        rank: i + 1,
        quoteVersionId: e.q.quoteVersionId,
        supplierOrgId: e.q.supplierOrgId,
        version: e.q.version,
        lane,
        landed: e.landed,
        goods: money(e.q.goodsTotalMinor, e.q.currency),
        charges: e.q.charges,
        deliveryPromisedBy: e.q.deliveryPromisedBy,
        paymentTerms: e.q.paymentTerms,
        lastUpdatedAt: e.q.lastUpdatedAt,
        source: e.q.source,
        completedOrders: completedOrders.get(e.q.supplierOrgId) ?? "No completed orders recorded",
      }));

  const lanes = { verified_agent: build("verified_agent"), manual: build("manual") };
  return {
    calculationVersion: CALCULATION_VERSION,
    sortedBy,
    lanes,
    excluded,
    noEligibleOffers: eligible.length === 0,
  };
}
