# Build status

Last updated: 2026-11-09. Honest record; nothing here is marked done unless it was executed.

## Environment
Node v20.18.0 (older LTS line; Node 22/24 preferred — **decision pending**), npm 11.6.4, git 2.46. **Docker is not installed and no local PostgreSQL has been confirmed**, so migrations and DB integration tests cannot run yet. pnpm absent; npm workspaces used.

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
- [ ] Migrations (needs PostgreSQL), CHECK constraints SQL
- [ ] Auth, sessions, CSRF, organisations, roles, tenant scoping + isolation tests
- [ ] Web app (Vite/React/Tailwind), design tokens, shell, component catalogue — **not started**
- [ ] Worker/outbox — **not started**

## Stage 2 — Procurement without AI
- [x] Pure domain: money, units, landed total, deterministic comparison with lanes/exclusions, approval-commit check, state machines (20 tests)
- [ ] Persistence, routes, UI, E2E; duplicate-order DB test

## Stage 3 — Concordium accountability
- [x] Typed results, trusted registry config, SSRF screen, card hash check, freshness (tests)
- [x] Placeholder verifier returns `unavailable`, never `verified`; demo verifier labelled simulated
- [ ] Real adapter, wallet ownership proof, authority binding, Agent Card publishing

## Stages 4–7
Not started: AI assistant, supplier agents, x402 payment (disabled), QA/screenshots/a11y, grant package. No screenshots exist; `docs/qa-report.md` records only what was run.

## Deferred (per brief)
Escrow, lending, custody, autonomous goods spending, custom tokens, multi-country settlement, native mobile.
