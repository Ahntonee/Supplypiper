# Design system

Source of truth: CSS custom properties in `apps/web/src/styles.css`; components in `apps/web/src/components/ui.tsx`; live catalogue at `/design` (all samples labelled sample content).

## Tokens
Colours follow the brief (canvas, surface, text, text-muted, border, primary, primary-hover, primary-soft, attention, danger, focus) with **one accessibility-driven addition**: `control-border #7C8B86`. The quiet `border #DCE4E0` is only 1.29:1 on white, which fails WCAG 1.4.11 for form-field boundaries, so inputs use `control-border` (3.56:1 on white, 3.34:1 on canvas). `border` stays for decorative card and divider edges.

`npm run contrast` style check: `node scripts/contrast.mjs` computes WCAG ratios for every pair used. All text pairs are ≥ 6.0:1; focus ring ≥ 4.8:1.

Typography: Inter Variable bundled locally via `@fontsource-variable/inter` (SIL OFL), system fallback; body 15px; titles 28/32px; headline 36px mobile / 52px desktop; tabular numerals on totals and quantities. Spacing on the 4px grid via Tailwind's scale. Radii 12px cards, 8px controls. Targets ≥ 44px (`min-h-11`).

## Layout
Shell: 248px sidebar and 72px top bar from 1024px; below that the sidebar becomes a native `<dialog>` drawer (focus trap, Escape, inert page from `showModal()`); content max 1280px. Skip link, landmarks (`nav`, `main`), labelled org switcher.

## Behaviour rules
- Money is never a float: amounts travel as integer-minor-unit strings and are formatted with BigInt (`Money`).
- Evidence panel shows identity, organisation authority and network as separate fields, with "What was checked" and "What remains unproven". Samples are labelled simulated/testnet.
- Reduced motion: animations collapse to ~0ms; skeletons reserve their final size.
- Session cookie is HttpOnly; only the CSRF token lives in memory. The selected-organisation id is the only thing in `localStorage` (a convenience; the server re-checks membership).
