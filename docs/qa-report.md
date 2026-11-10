# QA report

| Date | Command | Result |
|---|---|---|
| 2026-11-09 | `npm test` (Vitest 4.1.12) | 6 files, 74 tests passed (domain 24, concordium 19, api 7, integration auth/orgs 13, integration procurement 11). Integration ran against real local PostgreSQL on port 54329. No unit or browser tests exist for the web app itself |
| 2026-11-09 | `npm run typecheck` (api, packages, web) | exit 0 |
| 2026-11-09 | `npm run build:web` | OK; JS chunk 531 kB minified (Vite size warning, not code-split) |
| 2026-11-10 | `node scripts/visual-qa.mjs` (Playwright driving installed Google Chrome, reduced motion) | 29 page captures at 390/768/1440: 0 axe violations (wcag2a/2aa/21a/21aa/22aa tags), no horizontal scroll, 0 console errors. Results in `docs/visual-qa-results.json`, images in `docs/screenshots/` |
| 2026-11-09 | `node scripts/contrast.mjs` | all token pairs pass (text ≥ 6.0:1, focus ≥ 4.8:1, control-border ≥ 3.3:1) |
| 2026-11-09 | `npm run typecheck` (tsc, strict) | exit 0 |
| 2026-11-09 | `npm run db:validate` | Prisma schema valid |
| 2026-11-09 | `npm run spike:registry` | OK, read-only, output in `docs/spike-registry-output.json` |

Defects found by tests while building: IPv4-mapped IPv6 SSRF bypass (hex-normalised form) — fixed and covered; one incorrect ranking-test fixture — corrected.

**Not run:** E2E browser flows for the full procurement workflow (no UI for it yet), accessibility, visual screenshots, real-provider AI checks, testnet verification of a registered agent, x402. Nothing here should be read as covering them.

Mutation check: disabling the membership check made `denies cross-tenant access` fail (restored), so that test does detect a tenant leak.
Integration tests are labelled SKIPPED, not passed, when PostgreSQL is unreachable.
Mutation check 2: removing the approval-claim guard made the concurrent-confirm test fail (the partial unique index still blocked a duplicate order, returning 409 instead of a clean replay), so duplicate prevention is covered in two layers.
Test-data defects found by the suite: a budget too small for a 70 L scenario (system correctly refused approval) and a ranking fixture — both corrected in the tests, not the code.

Web defects found by running the app: (1) React StrictMode ran the single-use email-verify effect twice, so a successful verification displayed as a failed link, now deduplicated per token; (2) a skeleton `<div>` inside a `<p>` (invalid HTML, console error), fixed; (3) the quiet border token failed non-text contrast for form fields, added `control-border`.
By hand in the in-app browser: register, development-inbox verification, wrong-password error with input kept, sign-in, organisation creation (long name), validation errors, draft request saved and listed as NGN 120,000.00.
Automated 'clipped text' flags were all visually hidden elements (skip link, screen-reader label), not visible clipping.
Limits: axe is assistance, not proof of conformance. Not done: screen-reader testing, keyboard-only walkthrough of every flow (drawer Escape and form submit by Enter were exercised), Safari/Firefox/real Android device checks, screenshot baselines (images are for human review; no pixel-diff baseline is established), slow-network and offline states beyond the retry alerts.
