# QA report

| Date | Command | Result |
|---|---|---|
| 2026-11-10 | `npm test` (Vitest 4.1.12) | 6 files, 76 tests passed (domain 24, concordium 19, api 7, integration auth/orgs 13, integration procurement 13). Integration ran against real local PostgreSQL on port 54329 |
| 2026-11-10 | `npm run e2e:supplier` (Playwright driving installed Google Chrome, reduced motion) | Supplier journey through the real UI at 390, 768 and 1440 px, 8 screens each (24 checks): axe 0 violations, no horizontal scroll, no unexpected console errors. Results: `docs/e2e-supplier-results.json`; screenshots `docs/screenshots/supplier-*.png` |
| 2026-11-10 | `npm run e2e` (Playwright driving installed Google Chrome, reduced motion) | Buyer journey through the real UI at 390, 768 and 1440 px, 10 screens each (30 checks): axe 0 violations, no horizontal scroll, no console errors other than one expected 409. Results: `docs/e2e-results.json`; screenshots `docs/screenshots/buyer-*.png` |
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

Buyer-decision defects found by the end-to-end run (all fixed): (1) reloading or deep-linking to a request, approval or order crashed the page, because the data query is disabled until the organisation list loads and the screen then read `q.data!`; added a loading guard on all four and a friendly route error page; (2) after publishing, the Compare control was missing (and its 'no quotes yet' explanation) because it only rendered for later states; (3) at 768px the comparison page scrolled sideways: grid items needed `min-w-0`, and visually hidden (absolutely positioned) text inside the table escaped the scroll region, widening the page, so the region is now `relative`.
Test-side corrections (not product defects): stale-log race while waiting for a background run, leftover same-named suppliers from aborted runs (names now unique per run), ambiguous text matchers, a check that ran during the loading skeleton, and the single deliberate 409 now explicitly allowed.
What the journey covers: draft with validation, publish gated by supplier choice and consent, pending state with disabled compare, supplier quote via API, comparison with exact landed total, approval review, supplier revising the quote before confirm (approval refused with reasons, no order), fresh approval, order creation, supplier acceptance and delivery via API, buyer partial-receipt report, supplier's conflicting response shown beside it, buyer closing note, both reports still present, evidence download, supplier directory.
Still NOT covered: supplier-side UI (none exists), expired-approval and offline states in the browser, request cancel and order cancel dialogs, the earliest-delivery sort in the UI, keyboard-only walk-through and screen-reader testing, Safari/Firefox/real Android, pixel-diff baselines.

Supplier-workspace defects found by looking at the output (all fixed): (1) after choosing a catalogue product the price field kept a stale red 'empty' error beside a valid value, because the value was set without re-validating, axe did not flag it; visible only in a screenshot; now asserted in the journey; (2) timeline wording said 'You is preparing' and 'You reports', verbs were written for 'The supplier', now agree with either subject and asserted. Test-side corrections: assertion looked for the word 'budget', which the page's own explanatory sentence legitimately contains, so it now looks for the actual amount.
What the supplier journey covers: supplier-only onboarding, profile validation and save, honest 'not available yet' identity and agent-control sections, catalogue product and stock statement, inbox with no buyer amount, a supplier-staff user who can draft but has no Submit button, blocked empty submit with clear errors, catalogue prefill, calculate-from-price, unknown-charge warning, draft invisible to the buyer, submit draft, revise to v2 with v1 superseded, accept order (stock reserved, checked in the catalogue), preparing / dispatched / reported delivered, no supplier control to confirm receipt, response to the buyer's partial-delivery report with both versions visible.
Still NOT covered: decline-order flow and withdraw-quote dialog in the browser, request closing by deadline, expired quotes in the builder, invitation acceptance screens, keyboard-only and screen-reader passes, Safari/Firefox/real Android, pixel-diff baselines.
