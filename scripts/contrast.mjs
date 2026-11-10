// WCAG 2.x contrast ratios for the design-token pairs actually used in the UI.
const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const pairs = [
  ["text on canvas", "#142321", "#F6F8F7", 4.5], ["text on surface", "#142321", "#FFFFFF", 4.5],
  ["text-muted on surface", "#52625E", "#FFFFFF", 4.5], ["text-muted on canvas", "#52625E", "#F6F8F7", 4.5],
  ["white on primary", "#FFFFFF", "#145B50", 4.5], ["white on primary-hover", "#FFFFFF", "#10483F", 4.5],
  ["primary on primary-soft", "#145B50", "#E9F3EF", 4.5], ["primary on surface (links)", "#145B50", "#FFFFFF", 4.5],
  ["attention-text on attention-bg", "#754C00", "#FFF4D6", 4.5], ["danger-text on danger-bg", "#A52727", "#FDEDEC", 4.5],
  ["danger-text on surface", "#A52727", "#FFFFFF", 4.5], ["white on danger-text (danger button)", "#FFFFFF", "#A52727", 4.5],
  ["info text on info bg", "#174A99", "#E8F0FC", 4.5],
  ["focus ring on surface (non-text 3:1)", "#246BCE", "#FFFFFF", 3], ["focus ring on canvas (non-text 3:1)", "#246BCE", "#F6F8F7", 3],
  ["control-border on surface (form fields, 3:1)", "#7C8B86", "#FFFFFF", 3], ["control-border on canvas (disabled fields, 3:1)", "#7C8B86", "#F6F8F7", 3],
  ["border on surface (decorative; 3:1 not required)", "#DCE4E0", "#FFFFFF", 1],
];
for (const [n, f, b, min] of pairs) { const r = ratio(f, b); console.log(`${r >= min ? "PASS" : "FAIL"}  ${r.toFixed(2)}:1  (need ${min})  ${n}`); }
