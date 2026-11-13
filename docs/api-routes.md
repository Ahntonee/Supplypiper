# API routes (v1)

Hand-maintained until an OpenAPI file is generated (**OpenAPI is not done yet**). All routes are under `/api/v1`, need a session cookie, and mutating calls need `x-csrf-token` plus `application/json`. Errors: `{ error: { code, message, details, correlationId } }`. Tenant scope is derived from server-side membership; foreign organisations return 404.

| Area | Routes | Permission |
|---|---|---|
| Auth | `POST /auth/register, /verify-email, /login, /logout, /password-reset/request, /password-reset/confirm`, `GET /auth/me` | public / session |
| Orgs | `POST/GET /orgs`, `GET /orgs/:org`, `GET /orgs/:org/members`, `POST /orgs/:org/invitations`, `POST /invitations/accept` | member / `org.manage_members` |
| Supplier catalogue | `PUT/GET /orgs/:org/supplier-profile`, `POST/GET /orgs/:org/products`, `POST /orgs/:org/products/:id/inventory`, `GET /suppliers` | `catalogue.manage` / `catalogue.view` |
| Buyer requests | `POST/GET /orgs/:org/requests`, `PUT/GET /orgs/:org/requests/:id`, `POST .../publish`, `.../cancel`, `.../ready-for-comparison` | `request.create` / `request.publish` |
| Supplier inbox & quotes | `GET /orgs/:org/inbox`, `GET /orgs/:org/inbox/:requestId`, `POST /orgs/:org/requests/:req/quotes`, `POST /orgs/:org/quotes/:q/versions/:v/submit`, `POST /orgs/:org/quotes/:q/withdraw`, `GET /orgs/:org/requests/:req/quotes` | `quote.draft` / `quote.submit` |
| Comparison | `POST /orgs/:org/requests/:id/comparisons` | `order.view` (buyer org only) |
| Agents | `POST/GET /orgs/:org/agents`, `POST .../agents/:id/challenge`, `.../ownership`, `.../check`, `.../authorise`, `.../withdraw-authority` | `agent.manage` / `agent.authorise` (owner only) / `catalogue.view` |
| AI assistant | `GET /orgs/:org/assistant/status`, `POST .../assistant/intake`, `GET .../assistant/runs/:id`, `POST .../assistant/runs/:id/cancel`, `POST /orgs/:org/requests/:id/comparison-explanation` | `request.create` / `order.view` (buyer org) |
| Quote agent | `GET/PUT /orgs/:org/quote-agent`, `POST /orgs/:org/requests/:req/agent-draft` | `catalogue.view` / `catalogue.manage` (human-review bypass: owner) / `quote.draft` |
| Approval | `POST /orgs/:org/requests/:id/approval-intents`, `GET /orgs/:org/approvals/:intent` (status open / changed / expired / used), `POST /orgs/:org/approvals/:intent/confirm` | `approval.approve` |
| Orders | `GET /orgs/:org/orders[/:id]`, supplier: `POST .../accept, /decline, /progress, /discrepancy-response`; buyer: `POST .../cancel, /receipt, /discrepancy-resolution`; `GET .../export` | `order.accept` / `order.confirm_receipt` / `order.view` |
| Activity | `GET /orgs/:org/activity` | `audit.read` |

Idempotency: confirming an approval is idempotent per `intentId` (replay returns `200 {replay:true}`); order creation is additionally guarded by a unique `approvalId` and a partial unique index (one live order per RFQ). Other mutating commands are guarded by optimistic state/version checks, not by idempotency keys (**keys not implemented**).

Not implemented: supplier-agent quoting (refused with `AGENT_QUOTING_NOT_AVAILABLE`), change requests after acceptance, request expiry job, notification delivery, feedback and analytics endpoints, support role, contact-sharing policy enforcement.
