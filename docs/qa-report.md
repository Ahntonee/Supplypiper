# QA report

| Date | Command | Result |
|---|---|---|
| 2026-11-09 | `npm test` (Vitest 4.1.12) | 5 files, 61 tests passed (domain 24, concordium 19, api 6, integration 12). Integration ran against real local PostgreSQL on port 54329 |
| 2026-11-09 | `npm run typecheck` (tsc, strict) | exit 0 |
| 2026-11-09 | `npm run db:validate` | Prisma schema valid |
| 2026-11-09 | `npm run spike:registry` | OK, read-only, output in `docs/spike-registry-output.json` |

Defects found by tests while building: IPv4-mapped IPv6 SSRF bypass (hex-normalised form) — fixed and covered; one incorrect ranking-test fixture — corrected.

**Not run:** concurrency tests beyond the invitation double-accept, approval/order DB tests (no such code yet), E2E/browser, accessibility, visual screenshots, real-provider AI checks, testnet verification of a registered agent, x402. Nothing here should be read as covering them.

Mutation check: disabling the membership check made `denies cross-tenant access` fail (restored), so that test does detect a tenant leak.
Integration tests are labelled SKIPPED, not passed, when PostgreSQL is unreachable.
