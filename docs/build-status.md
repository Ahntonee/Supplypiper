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
- [x] Typed results, trusted registry config, SSRF screen, card hash check, freshness (tests)
- [x] Placeholder verifier returns `unavailable`, never `verified`; demo verifier labelled simulated
- [ ] Real adapter, wallet ownership proof, authority binding, Agent Card publishing

## Stages 4–7
Not started: AI assistant, supplier agents, x402 payment (disabled), QA/screenshots/a11y, grant package. No screenshots exist; `docs/qa-report.md` records only what was run.

## Deferred (per brief)
Escrow, lending, custody, autonomous goods spending, custom tokens, multi-country settlement, native mobile.
