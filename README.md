# SupplyPiper

*Source clearly. Approve confidently.* — an accountable, AI-assisted workflow for small businesses to request supplies, compare genuine supplier quotations and approve orders. First scope: palm oil, one delivery area in Nigeria (configurable), NGN.

**Status: early foundation.** See [docs/build-status.md](docs/build-status.md). The web app covers sign-up, sign-in, organisation setup, overview and draft requests only. There is no email delivery worker, AI assistant, agent verification or payment flow yet, and the rest of the procurement workflow works through the API only. Do not read this README as a feature list for those.

## What exists and works (tested)
- `packages/domain`: exact money (integer minor units), unit rules (no kg↔L), landed totals (unknown mandatory charge ⇒ incomplete), deterministic quote comparison with separate verified-agent and manual lanes and explicit exclusion reasons, approval-commit invalidation, state machines.
- `packages/concordium`: typed verification results, trusted-registry config (testnet/mainnet separate), SSRF-safe Agent Card URL screen, card hash check, freshness policy. The real chain check is **not implemented**; the placeholder returns `unavailable`.
- `apps/api`: health/readiness, environment banner endpoint, structured errors with correlation IDs, startup config guards.
- `prisma/schema.prisma` + migration: data model with integrity constraints, applied and tested on PostgreSQL.
- Web app (`apps/web`): responsive shell, design tokens, component catalogue (`/design`), sign-up/sign-in, organisation setup, overview, and the buyer's decision path: draft, choose suppliers and publish, request detail, quote comparison, approval review, orders, receipt and discrepancy handling, evidence download. Suppliers have their own workspace: profile, catalogue and declared stock, inbox, quote builder with revision history, and order handling. Tokens and rules: [docs/design-system.md](docs/design-system.md).
- Optional AI assistance (see [docs/ai-data-flow.md](docs/ai-data-flow.md)): the buyer assistant proposes a request from a description and can summarise a comparison; its output is re-validated by rules and never saves, publishes or approves anything. The supplier quote agent is **rule-based, no AI**. **Never exercised against a real AI provider** (no key available); with no provider every AI feature says "unavailable" and the product works fully without it.
- Agent accountability (see [docs/agent-accountability.md](docs/agent-accountability.md) and [docs/integration-research.md](docs/integration-research.md)): a real Concordium agent-registry verifier checked against live testnet data, wallet-signature ownership proof, separate organisation authority, and gating of the verified lane and of order approval. Positive real-wallet proof, agent registration/card publishing and mainnet are **not done**.
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
npm run dev:api              # API on :4000, reads .env (git-ignored; copy .env.example, set DEV_INBOX=true locally)
npm run dev:web              # web app on http://localhost:5173, proxies /api to :4000
npm run build:web
npm run qa:visual            # screenshots + axe at 390/768/1440 against the running stack
npm run e2e                  # buyer journey through the real UI (needs API, web, dev DB, DEV_INBOX=true)
npm run e2e:supplier         # supplier journey through the real UI
npm run e2e:ai               # AI-unavailable states + supplier quote agent journey (needs DEV_INBOX, mock verification, no AI provider)
npm run e2e:lane             # agent-evidence journey (buyer view; uses the labelled simulated demo checker)
LIVE_CONCORDIUM=1 npm run test:live   # read-only checks against the real testnet registry (otherwise reported skipped)
npm run probe:registry       # record real registry responses; scripts/find-valid-agents.mjs scans for passing agents
npm run contrast
```

## Verifying the main workflow
The buyer half works in the browser: start the stack (`npm run db:dev`, `npm run dev:api`, `npm run dev:web`) and run `npm run e2e`, which drives the buyer through the real UI while the supplier acts through the API. Also, `npm run test:integration` runs the reference scenario (`tests/integration/procurement.test.ts`) between two real organisations in PostgreSQL. Also: `npm test` exercises the quote comparison and approval-commit rules for the reference scenario (40 L, NGN 120,000 budget). Those numbers are a test scenario, not a market price.

## Ownership and rights
See [docs/ownership-and-rights-checklist.md](docs/ownership-and-rights-checklist.md). No open-source licence has been chosen.
