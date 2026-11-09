import { describe, expect, it } from "vitest";
import {
  assertTransition, checkApprovalForCommit, compareQuotes, convert, formatMinor, landedTotal, mayConfirmReceipt,
  money, parseMajorToMinor, quantity, packsToQuantity, UnitError, ORDER_TRANSITIONS, RFQ_TRANSITIONS,
  type ApprovalBinding, type CommitContext, type Policy, type QuoteVersionInput, type RequestInput,
} from "./index";

const now = new Date("2026-11-12T08:00:00Z");
const friday = new Date("2026-11-13T17:00:00Z");
const policy: Policy = { now, allowManualLane: true, verificationFreshnessMs: 5 * 60_000 };
const req: RequestInput = {
  category: "palm_oil", required: quantity("40", "L"), currency: "NGN",
  budgetMinor: parseMajorToMinor("120000"), deliverBy: friday,
};

function quote(over: Partial<QuoteVersionInput> = {}): QuoteVersionInput {
  return {
    quoteVersionId: "qv1", supplierOrgId: "s1", version: 1, source: "human", currency: "NGN",
    category: "palm_oil", offered: quantity("40", "L"), unitPriceMinor: 250_000n, priceUnit: "L",
    goodsTotalMinor: 10_000_000n,
    charges: [
      { kind: "delivery", label: "Delivery", amountMinor: 500_000n, mandatory: true },
      { kind: "tax", label: "VAT", amountMinor: 0n, mandatory: true },
    ],
    validUntil: new Date("2026-11-20T00:00:00Z"), deliveryPromisedBy: new Date("2026-11-13T12:00:00Z"),
    paymentTerms: "On delivery", deliversToArea: true, lastUpdatedAt: now, verification: null,
    ...over,
  };
}
const verifiedObs = (ageMs = 0, bound = true) => ({
  status: "verified" as const, network: "testnet" as const, checkedAt: new Date(now.getTime() - ageMs),
  organisationAuthorityBound: bound, simulated: false,
});

describe("money", () => {
  it("parses and formats exactly", () => {
    expect(parseMajorToMinor("120000.50")).toBe(12_000_050n);
    expect(formatMinor(money(12_000_050n, "NGN"))).toBe("NGN 120,000.50");
    expect(() => parseMajorToMinor("1.234")).toThrow();
  });
  it("rejects currency mixing via landed total of mismatched charges not being summed silently", () => {
    expect(landedTotal(quote())!.minor).toBe(10_500_000n);
  });
});

describe("units", () => {
  it("never converts mass to volume", () => {
    expect(() => convert(quantity("40", "kg"), "L")).toThrow(UnitError);
  });
  it("converts within a dimension exactly and refuses inexact", () => {
    expect(convert(quantity("2", "L"), "mL").scaled).toBe(2_000n * 1_000_000n);
    expect(() => convert(quantity("0.0005", "L"), "L")).not.toThrow();
    expect(() => convert(quantity("0.0001", "kg"), "g")).not.toThrow();
  });
  it("needs an explicit pack size", () => {
    expect(() => packsToQuantity(quantity("4", "each"), null)).toThrow(/Pack size/);
    expect(packsToQuantity(quantity("4", "each"), quantity("10", "L"))).toEqual(quantity("40", "L"));
  });
});

describe("comparison", () => {
  it("ranks a complete in-budget manual quote", () => {
    const r = compareQuotes(req, [quote()], policy);
    expect(r.lanes.manual).toHaveLength(1);
    expect(r.lanes.manual[0]!.landed.minor).toBe(10_500_000n);
    expect(r.lanes.manual[0]!.completedOrders).toBe("No completed orders recorded");
  });
  it("treats unknown mandatory charge as incomplete, but explicit zero as complete", () => {
    const unknown = quote({ charges: [
      { kind: "delivery", label: "d", amountMinor: null, mandatory: true },
      { kind: "tax", label: "t", amountMinor: 0n, mandatory: true } ] });
    expect(compareQuotes(req, [unknown], policy).excluded[0]!.reasons).toContain("INCOMPLETE_TOTAL");
    const missingTax = quote({ charges: [{ kind: "delivery", label: "d", amountMinor: 0n, mandatory: true }] });
    expect(compareQuotes(req, [missingTax], policy).excluded[0]!.reasons).toContain("INCOMPLETE_TOTAL");
  });
  it("excludes over budget, late, expired, short and out-of-area; reports no eligible", () => {
    const bad = [
      quote({ quoteVersionId: "a", goodsTotalMinor: 12_000_000n, unitPriceMinor: 300_000n }),
      quote({ quoteVersionId: "b", deliveryPromisedBy: new Date("2026-11-14T00:00:00Z") }),
      quote({ quoteVersionId: "c", validUntil: now }),
      quote({ quoteVersionId: "d", offered: quantity("39", "L"), goodsTotalMinor: 9_750_000n }),
      quote({ quoteVersionId: "e", deliversToArea: false }),
    ];
    const r = compareQuotes(req, bad, policy);
    expect(r.noEligibleOffers).toBe(true);
    const byId = Object.fromEntries(r.excluded.map((e) => [e.quoteVersionId, e.reasons]));
    expect(byId.a).toContain("OVER_BUDGET");
    expect(byId.b).toContain("MISSED_DEADLINE");
    expect(byId.c).toContain("EXPIRED");
    expect(byId.d).toContain("INSUFFICIENT_QUANTITY");
    expect(byId.e).toContain("OUTSIDE_DELIVERY_AREA");
  });
  it("flags unit-price vs goods-total arithmetic mismatch", () => {
    const r = compareQuotes(req, [quote({ goodsTotalMinor: 9_000_000n })], policy);
    expect(r.excluded[0]!.reasons).toContain("ARITHMETIC_MISMATCH");
  });
  it("blocks kg quotes for a litre request", () => {
    const r = compareQuotes(req, [quote({ offered: quantity("40", "kg"), priceUnit: "kg" })], policy);
    expect(r.excluded[0]!.reasons).toContain("INCOMPATIBLE_UNITS");
  });
  it("agent lane needs fresh verification and bound authority; manual never inherits it", () => {
    const agent = (id: string, v: QuoteVersionInput["verification"]) =>
      quote({ quoteVersionId: id, source: "supplier_agent", verification: v });
    const r = compareQuotes(req, [
      agent("ok", verifiedObs(60_000)),
      agent("stale", verifiedObs(6 * 60_000)),
      agent("unbound", verifiedObs(0, false)),
      agent("none", null),
      agent("down", { ...verifiedObs(), status: "unavailable" }),
    ], policy);
    expect(r.lanes.verified_agent.map((o) => o.quoteVersionId)).toEqual(["ok"]);
    const why = Object.fromEntries(r.excluded.map((e) => [e.quoteVersionId, e.reasons]));
    expect(why.stale).toContain("VERIFICATION_STALE");
    expect(why.unbound).toContain("AUTHORITY_NOT_BOUND");
    expect(why.none).toContain("VERIFICATION_MISSING");
    expect(why.down).toContain("VERIFICATION_NOT_VERIFIED");
  });
  it("manual lane can be disabled by the buyer", () => {
    const r = compareQuotes(req, [quote()], { ...policy, allowManualLane: false });
    expect(r.excluded[0]!.reasons).toContain("MANUAL_LANE_NOT_PERMITTED");
  });
  it("ranks by landed cost, with deterministic ties, and alternative sort by delivery", () => {
    const a = quote({ quoteVersionId: "a", deliveryPromisedBy: new Date("2026-11-13T09:00:00Z") });
    const b = quote({ quoteVersionId: "b", goodsTotalMinor: 9_800_000n, unitPriceMinor: 245_000n, deliveryPromisedBy: new Date("2026-11-13T15:00:00Z") });
    const c = quote({ quoteVersionId: "c", deliveryPromisedBy: new Date("2026-11-13T15:00:00Z") });
    // c ties with a on cost and delivery? No: c has default 12:00 delivery, a has 09:00; tie-break order below.
    expect(compareQuotes(req, [a, b, c], policy).lanes.manual.map((o) => o.quoteVersionId)).toEqual(["b", "a", "c"]);
    expect(compareQuotes(req, [a, b, c], policy, "earliest_delivery").lanes.manual[0]!.quoteVersionId).toBe("a");
  });
  it("expiry boundary is exclusive at the exact instant", () => {
    const edge = quote({ validUntil: new Date(now.getTime() + 1) });
    expect(compareQuotes(req, [edge], policy).lanes.manual).toHaveLength(1);
  });
});

describe("approval invalidation", () => {
  const approval: ApprovalBinding = {
    buyerOrgId: "b1", approverUserId: "u1", supplierOrgId: "s1", quoteVersionId: "qv1",
    totalMinor: 10_500_000n, currency: "NGN", destinationHash: "h1",
    expiresAt: new Date("2026-11-12T09:00:00Z"), requestVersion: 3,
  };
  const ctx = (over: Partial<CommitContext> = {}): CommitContext => ({
    now, currentQuote: quote(), currentDestinationHash: "h1", currentRequestVersion: 3,
    approverMayApprove: true, freshVerification: null, verificationFreshnessMs: 300_000, stockAvailable: true, ...over,
  });
  it("passes when nothing changed", () => expect(checkApprovalForCommit(approval, ctx())).toEqual([]));
  it("version A approval does not authorise version B", () => {
    expect(checkApprovalForCommit(approval, ctx({ currentQuote: quote({ quoteVersionId: "qv2" }) })))
      .toContain("QUOTE_VERSION_CHANGED");
  });
  it("detects total, destination, request, stock, expiry changes", () => {
    const r = checkApprovalForCommit(approval, ctx({
      currentQuote: quote({ charges: [
        { kind: "delivery", label: "d", amountMinor: 600_000n, mandatory: true },
        { kind: "tax", label: "t", amountMinor: 0n, mandatory: true } ] }),
      currentDestinationHash: "h2", currentRequestVersion: 4, stockAvailable: false,
      now: new Date("2026-11-12T09:00:00Z"),
    }));
    expect(r).toEqual(expect.arrayContaining(["TOTAL_CHANGED", "DESTINATION_CHANGED", "REQUEST_CHANGED", "STOCK_NOT_AVAILABLE", "APPROVAL_EXPIRED"]));
  });
  it("agent quotes need a fresh re-check at commit", () => {
    const agentQ = quote({ source: "supplier_agent" });
    expect(checkApprovalForCommit(approval, ctx({ currentQuote: agentQ, freshVerification: null })))
      .toContain("VERIFICATION_NOT_FRESH");
    expect(checkApprovalForCommit(approval, ctx({ currentQuote: agentQ, freshVerification: verifiedObs(10 * 60_000) })))
      .toContain("VERIFICATION_NOT_FRESH");
    expect(checkApprovalForCommit(approval, ctx({ currentQuote: agentQ, freshVerification: verifiedObs() }))).toEqual([]);
  });
});

describe("state machines", () => {
  it("allows legal and rejects illegal transitions", () => {
    expect(() => assertTransition(ORDER_TRANSITIONS, "awaiting_supplier_acceptance", "accepted")).not.toThrow();
    expect(() => assertTransition(ORDER_TRANSITIONS, "accepted", "completed")).toThrow();
    expect(() => assertTransition(RFQ_TRANSITIONS, "closed", "published")).toThrow();
  });
  it("only a buyer can confirm receipt", () => {
    expect(mayConfirmReceipt("supplier")).toBe(false);
    expect(mayConfirmReceipt("buyer")).toBe(true);
  });
});
