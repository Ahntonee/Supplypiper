# SupplyPiper

*Source clearly. Approve confidently.* — an accountable, AI-assisted workflow for small businesses to request supplies, compare genuine supplier quotations and approve orders. First scope: palm oil, one delivery area in Nigeria (configurable), NGN.

**Status: early foundation.** See [docs/build-status.md](docs/build-status.md). There is no web UI, email delivery worker, AI assistant, agent verification or payment flow yet. The procurement workflow works through the API only. Do not read this README as a feature list for those.

## What exists and works (tested)
- `packages/domain`: exact money (integer minor units), unit rules (no kg↔L), landed totals (unknown mandatory charge ⇒ incomplete), deterministic quote comparison with separate verified-agent and manual lanes and explicit exclusion reasons, approval-commit invalidation, state machines.
- `packages/concordium`: typed verification results, trusted-registry config (testnet/mainnet separate), SSRF-safe Agent Card URL screen, card hash check, freshness policy. The real chain check is **not implemented**; the placeholder returns `unavailable`.
- `apps/api`: health/readiness, environment banner endpoint, structured errors with correlation IDs, startup config guards.
- `prisma/schema.prisma` + migration: data model with integrity constraints, applied and tested on PostgreSQL.
- Procurement API (see [docs/api-routes.md](docs/api-routes.md)): RFQs, invited suppliers, versioned quotes, comparison, exact-version approval, orders, receipt, discrepancies, export.
- Auth and organisations API (`/api/v1/auth/*`, `/api/v1/orgs*`, `/api/v1/invitations/accept`): sessions, CSRF, roles, invitations, tenant isolation.

## Modes
| | Demo | Testnet pilot | Production |
|---|---|---|---|
| Data | synthetic | real participants, test tokens only | real |
| Verification | may be simulated, always labelled | real testnet checks | real, no mock fallback |
| Payments | disabled/simulated | testnet only (not built) | not enabled |
Startup refuses mock adapters or seeded credentials in production.

## Commands
```bash
npm install
npm run typecheck
npm test
npm run db:validate          # needs no live DB
npm run spike:registry       # read-only call to the hosted registry MCP
npm run db:dev               # local PostgreSQL (embedded-postgres), keep running in its own terminal
npm run db:deploy            # apply migrations (use DATABASE_URL in .env, git-ignored)
npm run test:integration     # real-DB auth/org/tenant tests
SUPPLYPIPER_MODE=demo VERIFICATION_ADAPTER=mock DATABASE_URL=... npm run dev:api
```

## Verifying the main workflow
Not yet possible through a UI. Through the API, `npm run test:integration` runs the reference scenario (`tests/integration/procurement.test.ts`) between two real organisations in PostgreSQL. Also: `npm test` exercises the quote comparison and approval-commit rules for the reference scenario (40 L, NGN 120,000 budget). Those numbers are a test scenario, not a market price.

## Ownership and rights
See [docs/ownership-and-rights-checklist.md](docs/ownership-and-rights-checklist.md). No open-source licence has been chosen.
