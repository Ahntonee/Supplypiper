// Visual and accessibility pass against a RUNNING dev stack (API + web + dev DB). Not part of `npm test`.
// Usage: node scripts/visual-qa.mjs   (WEB_URL defaults to http://localhost:5173)
// Writes docs/screenshots/*.png and docs/visual-qa-results.json. Automated axe results assist review; they do not prove WCAG conformance.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ w: 390, h: 844 }, { w: 768, h: 1024 }, { w: 1440, h: 1000 }];
const PW = "correct-horse-battery";
const results = { checkedAt: new Date().toISOString(), base: BASE, pages: [] };

async function api(method, path, body, csrf) {
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

async function newUser(label) {
  const email = `${label}-${Date.now()}@example.test`;
  await api("POST", "/auth/register", { email, password: PW, displayName: "Ada Buyer" });
  const inbox = await api("GET", `/dev/inbox?to=${encodeURIComponent(email)}`);
  await api("POST", "/auth/verify-email", { token: inbox.body.emails[0].data.token });
  return email;
}

async function check(page, name, vp, { full = true } = {}) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const clipped = await page.evaluate(() => [...document.querySelectorAll("h1,h2,h3,button,a,label,td,th")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible" && getComputedStyle(e).textOverflow !== "ellipsis").map((e) => e.textContent?.trim().slice(0, 40)));
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  await page.screenshot({ path: `${OUT}${name}-${vp.w}.png`, fullPage: full });
  results.pages.push({
    page: name, width: vp.w, horizontalScroll: overflow, clippedText: clipped,
    axeViolations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
  });
  console.log(`${name}@${vp.w}: overflow=${overflow} clipped=${clipped.length} axe=${axe.violations.length}`);
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));

    for (const [name, path] of [["home", "/"], ["login", "/login"], ["register", "/register"], ["catalogue", "/design"]]) {
      await page.goto(BASE + path); await check(page, name, vp);
    }

    const email = await newUser(`qa${vp.w}`);
    await page.goto(BASE + "/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PW);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/app");
    await page.getByRole("heading", { name: "Set up your organisation" }).waitFor();
    await check(page, "onboarding-org", vp);

    const csrf = await page.evaluate(async () => (await (await fetch("/api/v1/auth/me")).json()).csrfToken);
    const org = await page.evaluate(async (csrfToken) => {
      const r = await fetch("/api/v1/orgs", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ name: "Mama Put Kitchen and Catering Services Lagos Mainland", capabilities: ["buyer"] }) });
      return (await r.json()).id;
    }, csrf);
    await page.goto(BASE + "/app"); await page.getByRole("heading", { name: "Overview" }).waitFor();
    await check(page, "overview-empty", vp);

    await page.goto(BASE + "/app/requests/new"); await page.getByRole("heading", { name: "New request" }).waitFor();
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByText("Enter the delivery area").waitFor();
    await check(page, "request-new-errors", vp);

    await page.evaluate(async ({ csrfToken, orgId }) => {
      await fetch(`/api/v1/orgs/${orgId}/requests`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ category: "palm_oil", quantity: "40", unit: "L", budget: "120000.00", currency: "NGN", deliverBy: new Date(Date.now() + 3 * 864e5).toISOString(), deliverTz: "Africa/Lagos", destinationArea: "Lagos Mainland", destinationAddress: "12 Allen Avenue, Ikeja", allowManualLane: true }) });
    }, { csrfToken: csrf, orgId: org });
    await page.goto(BASE + "/app/requests"); await page.getByRole("table").waitFor();
    await check(page, "requests-list", vp);
    await page.goto(BASE + "/app"); await page.getByRole("heading", { name: "Overview" }).waitFor();
    await check(page, "overview-with-request", vp);

    if (vp.w < 1024) {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("dialog").waitFor();
      await check(page, "mobile-drawer-open", vp, { full: false });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    results.pages.push({ page: "console-errors", width: vp.w, errors });
    await ctx.close();
  }
} finally {
  await browser.close();
  writeFileSync(new URL("../docs/visual-qa-results.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify(results, null, 2));
}
