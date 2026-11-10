/** Plain-language names for states, events and rejection reasons. The server stays the source of truth for the codes. */
export const REQUEST_STATE: Record<string, { label: string; tone: "neutral" | "info" | "success" | "attention" | "danger" }> = {
  draft: { label: "Draft", tone: "neutral" }, published: { label: "Published", tone: "info" }, collecting: { label: "Collecting quotes", tone: "info" },
  ready_for_comparison: { label: "Ready to compare", tone: "success" }, selected: { label: "Order placed", tone: "success" }, closed: { label: "Closed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "danger" }, expired: { label: "Expired", tone: "danger" },
};

export const ORDER_STATE: Record<string, { label: string; tone: "neutral" | "info" | "success" | "attention" | "danger" }> = {
  awaiting_supplier_acceptance: { label: "Waiting for supplier to accept", tone: "attention" }, accepted: { label: "Accepted by supplier", tone: "info" },
  preparing: { label: "Being prepared", tone: "info" }, dispatched: { label: "Dispatched", tone: "info" },
  delivered_awaiting_buyer_confirmation: { label: "Supplier says delivered: confirm receipt", tone: "attention" },
  completed: { label: "Completed", tone: "success" }, declined: { label: "Declined by supplier", tone: "danger" }, cancelled: { label: "Cancelled", tone: "danger" },
  partially_fulfilled: { label: "Partly received", tone: "attention" }, issue_reported: { label: "Problem reported", tone: "danger" },
};

export const EVENT_TEXT: Record<string, string> = {
  "request.drafted": "Draft created", "request.published": "Published to suppliers", "request.ready_for_comparison": "Marked ready to compare",
  "request.cancelled": "Request cancelled", "approval.intent_issued": "Approval prepared for review", "approval.rejected": "An approval was refused because something changed",
  "order.created": "Order created from an approved quote",
};

export const APPROVAL_REJECTION: Record<string, string> = {
  APPROVAL_EXPIRED: "The approval window (15 minutes) has passed.",
  QUOTE_VERSION_CHANGED: "The supplier changed or replaced this quote after you reviewed it.",
  QUOTE_WITHDRAWN: "The supplier withdrew this quote.",
  QUOTE_EXPIRED: "The quote's validity period has ended.",
  TOTAL_CHANGED: "The landed total is no longer the amount you reviewed.",
  CURRENCY_CHANGED: "The quote's currency changed.", SUPPLIER_CHANGED: "The supplier on the quote changed.",
  DESTINATION_CHANGED: "The delivery destination changed.", REQUEST_CHANGED: "The request is no longer open for approval.",
  STOCK_NOT_AVAILABLE: "The supplier's declared stock no longer covers this quantity.",
  APPROVER_NOT_PERMITTED: "Your role cannot approve orders.",
  VERIFICATION_NOT_FRESH: "The agent identity check is out of date.", AUTHORITY_NOT_BOUND: "The supplier has not authorised this agent.",
};

export const DISPLAY_QUANTITY = (scaled: string, unit: string) => {
  const v = BigInt(scaled);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${unit}`;
};
