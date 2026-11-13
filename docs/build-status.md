# Build status

Last updated: 2026-11-09. Honest record; nothing here is marked done unless it was executed.

## Environment
Node v20.18.0 (older LTS line; Node 22/24 preferred — **decision pending**), npm 11.6.4, git 2.46. Docker is not installed; local development uses real PostgreSQL binaries via `embedded-postgres` (`npm run db:dev`, port 54329, data in git-ignored `.pgdata/`). pnpm absent; npm workspaces used.

## Stage 0 — Research and contract
- [x] Official sources fetched (summaries) — `docs/integration-research.md`
- [x] Read-only live registry spike run (testnet + mainnet metadata) — `docs/spike-registry-output.json`
- [x] Ownership/rights checklist (no invented terms)
- [x] Runnable scaffold (workspaces, TS strict, Vitest)
- [ ] Hackathon brief, wallet, x402, sponsored-tx, SDK releases not yet read
- [ ] Threat model document, issue checklist
- [ ] Registered-agent testnet check (blocked: needs wallet/agent; shapes unobserved)

## Stage 1 — Foundation
- [x] API skeleton: correlation IDs, structured errors, health/ready, environment banner endpoint, config guards (production cannot use mock adapters / seeded creds)
- [x] Prisma schema for all required entities, validates (`npm run db:validate`)
- [x] Migration `20261109214558_init` applied to real PostgreSQL, with CHECK constraints, quote-version immutability and append-only audit triggers
- [x] Auth: register/verify-email/login/logout/me, password reset (single-use, revokes sessions), DB-backed login rate limit, HttpOnly SameSite cookie, per-session CSRF token, origin/JSON guards
- [x] Organisations, memberships, role+capability permissions, invitations (expiry, single-use, email-bound), server-derived tenant scope, cross-tenant denial tests (12 integration tests)
- [ ] Not yet: email delivery worker (outbox rows are written, nothing sends them), contact verification beyond email, org switching UI, platform support role, per-IP limits behind proxies untested, CORS config, CSP/security headers beyond basics, session listing/revocation UI
- [x] Web foundation (Vite 6, React 19, Tailwind 4, TanStack Query, React Hook Form + Zod): design tokens, responsive shell (sidebar ≥1024px, native-dialog drawer below), component catalogue at `/design`, public homepage, register/verify/login, development inbox, organisation onboarding, overview with real counts, requests list, new-request form (saves drafts to the real API) — see `docs/design-system.md`
- [x] Buyer decision screens: request detail with activity timeline and next step, supplier choice + publish with an explicit "what suppliers will see / not see" preview and consent, supplier directory (claimed details, no ratings), quote comparison (labelled cards under 768px, full keyboard-reachable table above, sort by landed cost or earliest delivery, separate verified-agent and manual lanes, exclusions with reasons, "Why this matches", deterministic-not-AI label), approval review bound to one quote version and exact total with a server-issued 15-minute intent, rejection screen that lists what changed, orders list and detail (party-labelled timeline, buyer-only receipt: full / part / problem, supplier's response shown beside the buyer's report, buyer closes with a note, JSON evidence export)
- [x] Browser E2E for the buyer journey (`npm run e2e`, `tests/e2e/buyer-decision.mjs`): real UI for the buyer, real API for the supplier
- [x] Supplier workspace: supplier-only or dual-capability organisations, profile (claimed details, labelled as such), catalogue with declared-stock statements (reservations carry over and cannot be restated below what is reserved), inbox of invited requests (buyer budget never shown), quote builder (live landed total from exact arithmetic, unknown required charges flagged as incomplete, calculate-from-price, product link to declared stock, drafts, submit, withdraw, full revision history), supplier order handling (accept with stock reservation, decline with reason, preparing / dispatched / reported delivered, response to a buyer's problem report kept beside it), role limits mirrored in the UI (staff can draft, managers submit and respond)
- [x] Browser E2E for the supplier journey (`npm run e2e:supplier`): real UI for the supplier, real API for the buyer
- [x] Agent identity setup and quote-agent controls are shown as **Not available yet**, with the planned steps and limits stated; no control exists for them
- [ ] Web not yet: settings, member and invitation screens, notifications, expiry/auto-close behaviours, change requests after acceptance, code-splitting (JS bundle ~530 kB minified), demo mode and its synthetic data, dark theme, screen-reader testing
- [ ] Worker/outbox — **not started**

## Stage 2 — Procurement without AI
- [x] Pure domain: money, units, landed total, deterministic comparison with lanes/exclusions, approval-commit check, state machines
- [x] Procurement API on PostgreSQL (`docs/api-routes.md`): supplier profile/products/inventory, RFQ draft→publish with explicit share confirmation, invited-only inbox (budget hidden), versioned quotes (submitted versions frozen by DB trigger), deterministic comparison persisted per run, approval intents bound to exact version/total, transactional order creation, supplier accept/decline with atomic stock reservation, delivery progress, buyer-only receipt, preserved conflicting discrepancy reports, party-scoped evidence export, activity log
- [x] 11 integration tests incl. the reference scenario between two organisations, concurrent confirms, stock conflicts, cross-tenant denial, role limits
- [ ] Not yet: web UI, browser E2E, expiry/closing jobs, change requests after acceptance, notification delivery, idempotency keys on other commands, OpenAPI, feedback/analytics endpoints, request edits after publish (by design: new RFQ)
- Two parties can complete the workflow **via API calls** only. No human-facing interface exists yet.

## Stage 3 — Concordium accountability
- [x] **Real testnet verifier** (`packages/concordium`): decodes the token address itself, checks the configured trusted registry, reads `agent_of`, checks Active/Revoked, owner = proven owner, fetches the Agent Card itself (hardened: https only, no redirects, size and time caps, private addresses refused at connect time), hashes the served bytes against the on-chain anchor, and compares the card's badge (extension or legacy form) with the chain. Outcomes map to our own statuses; outage is `unavailable`.
- [x] **Observed against real testnet data** (opt-in live tests, read-only): a real agent verifies; a real revoked agent is revoked; a real agent whose card 404s is invalid; the wrong owner is refused; real account keys load via gRPC. Real recorded responses are the unit-test fixtures.
- [x] Wallet-signature ownership proof (one-time, expiring, context-bound challenge; verified with the SDK against current on-chain keys): tested with SDK-made signatures and local keys
- [x] API + data: agent registration (trusted registry per environment), challenge/ownership, check-now, **separate** owner-only authorise/withdraw, authority void on owner change (DB constraint too), every check stored, last successful check kept distinct
- [x] Gating in the decision: verified lane needs fresh verified identity + valid organisation authority + agent registered to the quoting organisation; approval re-checks identity at commit (outside the transaction, bound to the quote version); a cached green result is never enough; recorded on the order. Mutation-checked.
- [x] UI: supplier agent page (four separate steps, evidence panel, manual signature step marked untested with a real wallet), buyer evidence in comparison, excluded-agent reasons, order evidence line. Browser journeys at 390/768/1440.
- [ ] **Not done / blocked:** a positive proof from a **real wallet** (no browser-wallet connection; needs a testnet wallet account owning a testnet agent); registration and Agent Card **publishing** and badge anchoring (the hosted tool `build_set_agent_uri` is missing live); independent chain reads (we trust one hosted service for `agent_of`); mainnet never run; Nigerian identity-document and mobile-wallet checks unverified; official brand mark not obtained (none used).
- [ ] Agent-sourced quotes cannot be **created** through the product yet (no quoting agent; Stage 4); the gating is exercised by inserting them directly in tests.

## Stage 4 — AI assistance and supplier agent
- [x] Provider-neutral core (`packages/agent-tools`): provider interface, Anthropic provider (official SDK, strict tool schemas, no forced tool choice, refusal handling), tool registry with a **policy the model cannot override** (mutating or human-confirmed tools are neither offered nor callable), bounded loop (tool calls, turns, cost, deadline, per-call token cap from remaining budget), cancellation, idempotent tool executions, redacted trace
- [x] Buyer assistant: request intake (validate / ask / propose; saves and publishes nothing; every value re-validated by deterministic rules) and comparison explanation (AI summary accepted only if every figure and label matches the calculation; otherwise discarded and the rule-based text stands). Persisted runs with legal states, hourly per-user limit, stale-run recovery. See `docs/ai-data-flow.md`.
- [x] Supplier quote agent: **rule-based, no AI model**; catalogue + rules → exact price; refuses instead of guessing; drafts for human review by default; owner-only review bypass; authority rechecked at submission; quotes enter the verified lane only while identity and authority hold
- [x] UI: assistant card on the new-request page (honest "unavailable" when no provider), explain button on the comparison, quote agent settings and a draft button on supplier requests. Browser journey at 390/768/1440.
- [ ] **Never exercised against the real provider** (no API key was available); only a scripted model. Real-provider check with bounded cost needs a key and approval of the spend. Refusal fallback flag untested (off). Default prices need verifying.
- [ ] Not done: retention/deletion policy for AI runs; assistant for supplier-side tasks beyond the rule engine; browser test of the AI-filled form (no provider here, so only the unavailable state is covered in the browser; the filled/clarify/failed states are covered by API tests); streaming; prompt-quality evaluation set beyond the scripted fixtures.

## Stages 5–7
Not started: x402 payment (disabled), final QA and deployment rehearsal, grant package. `docs/qa-report.md` records only what was run.

## Deferred (per brief)
Escrow, lending, custody, autonomous goods spending, custom tokens, multi-country settlement, native mobile.
