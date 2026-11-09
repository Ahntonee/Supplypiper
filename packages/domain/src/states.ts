/** Explicit state machines. Anything not listed is illegal. Mirrored in docs/workflows.md. */
export type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

export const RFQ_STATES = [
  "draft", "published", "collecting", "ready_for_comparison", "selected", "closed", "cancelled", "expired",
] as const;
export type RfqState = (typeof RFQ_STATES)[number];
export const RFQ_TRANSITIONS: Transitions<RfqState> = {
  draft: ["published", "cancelled"],
  published: ["collecting", "cancelled", "expired"],
  collecting: ["ready_for_comparison", "cancelled", "expired"],
  ready_for_comparison: ["selected", "collecting", "cancelled", "expired"],
  selected: ["closed", "ready_for_comparison"],
  closed: [],
  cancelled: [],
  expired: [],
};

export const QUOTE_STATES = ["draft", "submitted", "superseded", "withdrawn", "expired"] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];
export const QUOTE_TRANSITIONS: Transitions<QuoteState> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["superseded", "withdrawn", "expired"],
  superseded: [],
  withdrawn: [],
  expired: [],
};

export const ORDER_STATES = [
  "awaiting_supplier_acceptance", "accepted", "preparing", "dispatched",
  "delivered_awaiting_buyer_confirmation", "completed",
  "declined", "cancelled", "partially_fulfilled", "issue_reported",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const ORDER_TRANSITIONS: Transitions<OrderState> = {
  awaiting_supplier_acceptance: ["accepted", "declined", "cancelled"],
  accepted: ["preparing", "cancelled"], // post-acceptance cancel goes via a change request, both responses stored
  preparing: ["dispatched", "cancelled"],
  dispatched: ["delivered_awaiting_buyer_confirmation", "issue_reported"],
  delivered_awaiting_buyer_confirmation: ["completed", "partially_fulfilled", "issue_reported"],
  partially_fulfilled: ["completed", "issue_reported"],
  issue_reported: ["completed", "partially_fulfilled", "cancelled"],
  completed: [],
  declined: [],
  cancelled: [],
};

export const AGENT_RUN_STATES = [
  "draft", "needs_clarification", "awaiting_publish_approval", "requesting_quotes", "awaiting_responses",
  "verifying", "comparing", "awaiting_order_approval", "completed", "blocked", "cancelled", "failed",
] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];
export const AGENT_RUN_TRANSITIONS: Transitions<AgentRunState> = {
  draft: ["needs_clarification", "awaiting_publish_approval", "cancelled", "failed", "blocked"],
  needs_clarification: ["draft", "awaiting_publish_approval", "cancelled", "failed"],
  awaiting_publish_approval: ["requesting_quotes", "needs_clarification", "cancelled", "failed"],
  requesting_quotes: ["awaiting_responses", "blocked", "cancelled", "failed"],
  awaiting_responses: ["verifying", "comparing", "cancelled", "failed", "blocked"],
  verifying: ["comparing", "blocked", "cancelled", "failed"],
  comparing: ["awaiting_order_approval", "needs_clarification", "completed", "blocked", "cancelled", "failed"],
  awaiting_order_approval: ["completed", "comparing", "cancelled", "failed", "blocked"],
  blocked: ["draft", "verifying", "comparing", "cancelled", "failed"], // recovery after outage
  completed: [],
  cancelled: [],
  failed: [],
};

export class IllegalTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Illegal transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition<S extends string>(table: Transitions<S>, from: S, to: S): boolean {
  return table[from].includes(to);
}

export function assertTransition<S extends string>(table: Transitions<S>, from: S, to: S): void {
  if (!canTransition(table, from, to)) throw new IllegalTransitionError(from, to);
}

/** Roles who may perform the buyer-side "receipt" step. A supplier update can never be buyer confirmation. */
export type Party = "buyer" | "supplier" | "platform_support";
export function mayConfirmReceipt(party: Party): boolean {
  return party === "buyer";
}
