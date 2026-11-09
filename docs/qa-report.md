# QA report

| Date | Command | Result |
|---|---|---|
| 2026-11-09 | `npm test` (Vitest 4.1.12) | 3 files, 45 tests passed: domain (20), concordium (19: SSRF/hash/freshness/adapters), api config + HTTP (6) |
| 2026-11-09 | `npm run typecheck` (tsc, strict) | exit 0 |
| 2026-11-09 | `npm run db:validate` | Prisma schema valid |
| 2026-11-09 | `npm run spike:registry` | OK, read-only, output in `docs/spike-registry-output.json` |

Defects found by tests while building: IPv4-mapped IPv6 SSRF bypass (hex-normalised form) — fixed and covered; one incorrect ranking-test fixture — corrected.

**Not run:** PostgreSQL integration, concurrency, E2E/browser, accessibility, visual screenshots, real-provider AI checks, testnet verification of a registered agent, x402. Nothing here should be read as covering them.
