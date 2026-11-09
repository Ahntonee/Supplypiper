import { landedTotal, type QuoteVersionInput, type VerificationObservation } from "./comparison";

/** What the buyer approved. Bound to one immutable quote version. */
export interface ApprovalBinding {
  buyerOrgId: string;
  approverUserId: string;
  supplierOrgId: string;
  quoteVersionId: string;
  totalMinor: bigint;
  currency: string;
  destinationHash: string;
  expiresAt: Date;
  /** Optimistic lock: the request version the buyer reviewed. */
  requestVersion: number;
}

export type ApprovalRejection =
  | "APPROVAL_EXPIRED" | "QUOTE_VERSION_CHANGED" | "TOTAL_CHANGED" | "CURRENCY_CHANGED"
  | "SUPPLIER_CHANGED" | "DESTINATION_CHANGED" | "REQUEST_CHANGED" | "QUOTE_EXPIRED"
  | "VERIFICATION_NOT_FRESH" | "AUTHORITY_NOT_BOUND" | "STOCK_NOT_AVAILABLE" | "APPROVER_NOT_PERMITTED";

export interface CommitContext {
  now: Date;
  currentQuote: QuoteVersionInput;
  currentDestinationHash: string;
  currentRequestVersion: number;
  approverMayApprove: boolean;
  /** Fresh re-check made immediately before commit; null if the lane is manual. */
  freshVerification: VerificationObservation | null;
  verificationFreshnessMs: number;
  stockAvailable: boolean;
}

/** Any non-empty result means: do not create the order; tell the user what changed. */
export function checkApprovalForCommit(a: ApprovalBinding, c: CommitContext): ApprovalRejection[] {
  const r: ApprovalRejection[] = [];
  if (!c.approverMayApprove) r.push("APPROVER_NOT_PERMITTED");
  if (c.now.getTime() >= a.expiresAt.getTime()) r.push("APPROVAL_EXPIRED");
  if (c.currentQuote.quoteVersionId !== a.quoteVersionId) r.push("QUOTE_VERSION_CHANGED");
  if (c.currentQuote.supplierOrgId !== a.supplierOrgId) r.push("SUPPLIER_CHANGED");
  if (c.currentQuote.currency !== a.currency) r.push("CURRENCY_CHANGED");
  const landed = landedTotal(c.currentQuote);
  if (landed === null || landed.minor !== a.totalMinor) r.push("TOTAL_CHANGED");
  if (c.currentDestinationHash !== a.destinationHash) r.push("DESTINATION_CHANGED");
  if (c.currentRequestVersion !== a.requestVersion) r.push("REQUEST_CHANGED");
  if (c.currentQuote.validUntil.getTime() <= c.now.getTime()) r.push("QUOTE_EXPIRED");
  if (!c.stockAvailable) r.push("STOCK_NOT_AVAILABLE");

  if (c.currentQuote.source === "supplier_agent") {
    const v = c.freshVerification;
    if (!v || v.status !== "verified" || c.now.getTime() - v.checkedAt.getTime() > c.verificationFreshnessMs) {
      r.push("VERIFICATION_NOT_FRESH");
    }
    if (!v || !v.organisationAuthorityBound) r.push("AUTHORITY_NOT_BOUND");
  }
  return r;
}
