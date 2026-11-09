# Workflows

Source of truth is `packages/domain/src/states.ts` (tests in `domain.test.ts`). Anything not listed is illegal.

## RFQ
draft → published | cancelled
published → collecting | cancelled | expired
collecting → ready_for_comparison | cancelled | expired
ready_for_comparison → selected | collecting | cancelled | expired
selected → closed | ready_for_comparison (approval invalidated)

## Quote (versioned; approval binds one version)
draft → submitted | withdrawn; submitted → superseded | withdrawn | expired

## Order
awaiting_supplier_acceptance → accepted | declined | cancelled
accepted → preparing | cancelled (post-acceptance cancel is a change request; both responses stored)
preparing → dispatched | cancelled
dispatched → delivered_awaiting_buyer_confirmation | issue_reported
delivered_awaiting_buyer_confirmation → completed | partially_fulfilled | issue_reported
partially_fulfilled → completed | issue_reported; issue_reported → completed | partially_fulfilled | cancelled

Only the buyer party can confirm receipt (`mayConfirmReceipt`). Supplier delivery updates are never buyer confirmation. Conflicting reports are stored side by side (`Discrepancy.buyerReport` / `supplierReport`).

## Agent run
draft → needs_clarification → awaiting_publish_approval → requesting_quotes → awaiting_responses → verifying → comparing → awaiting_order_approval → completed. `blocked` (e.g. verification outage) can recover to draft/verifying/comparing; `cancelled` and `failed` are terminal. No DB transaction is held across an LLM or network call.

## Approval → order commit
Server-issued intent bound to buyer, supplier, quote version, exact total, currency, destination hash, request version, expiry. At commit, `checkApprovalForCommit` re-evaluates: approver permission, expiry, quote version, supplier, currency, recomputed landed total, destination, request version, quote validity, stock, and — for agent quotes — a fresh verification observation (≤ freshness policy) plus bound organisation authority. Any rejection returns reason codes; no order is created. Unique constraint on `Order.approvalId` and `Approval.intentId` plus optimistic versions make retries and two tabs create at most one order (**DB enforcement pending migration; schema encodes it**).
Chain state may change after the check; we record the observation and do not claim atomicity across chain and database.
