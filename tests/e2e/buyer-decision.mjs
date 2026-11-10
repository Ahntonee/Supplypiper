// End-to-end buyer journey through the REAL UI against a RUNNING dev stack (API + web + dev DB, DEV_INBOX=true).
// The supplier acts through the real API here; see supplier-workspace.mjs for the supplier UI. Run: node tests/e2e/buyer-decision.mjs
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { BASE, DAY, PW, VIEWPORTS, check as baseCheck, iso, localInput, verifiedUser } from "./lib.mjs";

const report = { checkedAt: new Date().toISOString(), runs: [] };
const check = (page, name, vp, run) => baseCheck(page, name, vp, run, "buyer");

async function supplierWorld(tag) {
  tag = `${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`; // unique per run: the directory lists every supplier in the environment
  const { a, email } = await verifiedUser(`supplier${tag}`);
  await a.login(email);
  const org = (await a.call("POST", "/orgs", { name: `E2E Palm Oil Traders ${tag}`, capabilities: ["supplier"] })).body.id;
  assert.equal((await a.call("PUT", `/orgs/${org}/supplier-profile`, { category: "palm_oil", areaCode: "lagos-mainland" })).status, 200);
  const product = (await a.call("POST", `/orgs/${org}/products`, { name: "Palm oil 25L", category: "palm_oil", unit: "L", priceBasis: "per litre", unitPrice: "2500.00" })).body.id;
  assert.equal((await a.call("POST", `/orgs/${org}/products/${product}/inventory`, { available: "100" })).status, 201);
  return { a, org, product, name: `E2E Palm Oil Traders ${tag}` };
}
const quote = (s, over = {}) => ({ productId: s.product, category: "palm_oil", offeredQuantity: "40", offeredUnit: "L", unitPrice: "2500.00", priceUnit: "L", goodsTotal: "100000.00",
  charges: [{ kind: "delivery", label: "Delivery", amount: "5000.00", mandatory: true }, { kind: "tax", label: "VAT", amount: "0.00", mandatory: true }],
  validUntil: iso(2 * DAY), deliveryPromisedBy: iso(2 * DAY), deliveryTz: "Africa/Lagos", paymentTerms: "Pay on delivery", deliversToArea: true, submit: true, ...over });

async function journey(browser, vp) {
  const holder = {};
  try { return await journeyInner(browser, vp, holder); } catch (e) {
    if (holder.page) { const p = `${tmpdir()}/e2e-fail-${vp.w}.png`; await holder.page.screenshot({ path: p, fullPage: true }).catch(() => {}); console.error(`failure screenshot: ${p}  url: ${holder.page.url()}`);
      const wide = await holder.page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => !e.closest("[role=region]") && e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 70)} right=${Math.round(e.getBoundingClientRect().right)}`)).catch(() => []);
      if (wide.length) console.error(["elements past the viewport edge:", ...wide.map((w) => "  " + w)].join("\n"));
      const chain = await holder.page.evaluate(() => { const out = []; let e = document.querySelector("[role=region]"); while (e && e !== document.documentElement) { out.push(`${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} w=${Math.round(e.getBoundingClientRect().width)} display=${getComputedStyle(e).display}`); e = e.parentElement; } return out; }).catch(() => []);
      if (chain.length) console.error(["region ancestor chain:", ...chain.map((c) => "  " + c)].join("\n")); }
    throw e;
  }
}

async function journeyInner(browser, vp, holder) {
  const run = { width: vp.w, checks: [], errors: [] };
  const sup = await supplierWorld(vp.w);
  const { email } = await verifiedUser(`buyer${vp.w}`);
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && run.errors.push(m.text()));
  page.on("pageerror", (e) => run.errors.push(String(e)));
  page.on("close", () => {});
  holder.page = page;
  const heading = (name) => page.getByRole("heading", { name, level: 1 }).waitFor();

  // sign in and set up the organisation through the real UI
  await page.goto(BASE + "/login");
  await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await heading("Set up your organisation");
  await page.getByLabel("Organisation name").fill("Mama Put Kitchen");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await heading("Overview");

  // draft a request
  await page.goto(BASE + "/app/requests/new"); await heading("New request");
  await page.getByLabel("Quantity").fill("40");
  await page.getByLabel("Maximum landed cost (NGN)").fill("120000");
  await page.getByLabel("Deliver by").fill(localInput(3 * DAY));
  await page.getByLabel("Delivery area").fill("lagos-mainland");
  await page.getByLabel("Delivery address").fill("12 Allen Avenue, Ikeja");
  await page.getByLabel("Allow quotes entered by a person at the supplier").check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("Draft saved").waitFor();
  await page.getByRole("link", { name: /palm oil/i }).first().click();
  await heading(/palm oil/i);
  await check(page, "request-draft", vp, run);

  // publish: choose the supplier, see what they will and won't see
  await page.getByRole("link", { name: "Choose suppliers and publish" }).click();
  await heading("Choose suppliers");
  await page.getByText("Not shared:").waitFor();
  const publishBtn = page.getByRole("button", { name: /^Publish to/ });
  await publishBtn.click();
  await page.getByText("Choose at least one supplier").waitFor(); // blocked without choices and without consent
  await page.getByRole("checkbox", { name: new RegExp(sup.name) }).check();
  await check(page, "publish", vp, run);
  await page.getByRole("checkbox", { name: /I understand this shares/ }).check();
  await page.getByRole("button", { name: /^Publish to 1 supplier/ }).click();
  await page.getByText("Waiting for a reply").waitFor();
  assert.ok(await page.getByRole("button", { name: "Compare quotes" }).isDisabled(), "compare is disabled while no quotes exist");
  await check(page, "request-waiting", vp, run);
  const requestUrl = page.url();
  const requestId = requestUrl.split("/").pop();

  // supplier responds (API), buyer sees a real quote, not a generated one
  const q1 = await sup.a.call("POST", `/orgs/${sup.org}/requests/${requestId}/quotes`, quote(sup));
  assert.equal(q1.status, 201, JSON.stringify(q1.body));
  await page.reload(); await page.getByText("Quote received", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Compare quotes" }).click();
  await heading("Compare quotes");
  await page.getByText("NGN 105,000.00").locator("visible=true").first().waitFor();
  assert.ok(await page.getByText("NGN 105,000.00").locator("visible=true").first().isVisible(), "landed total shown exactly");
  assert.ok(await page.getByText("not an AI summary", { exact: false }).first().isVisible());
  await check(page, "compare", vp, run);

  // prepare approval, then the supplier changes the quote before the buyer confirms
  await page.getByRole("button", { name: /Review and approve/ }).first().click();
  await heading("Review before you approve");
  assert.ok(await page.getByRole("button", { name: "Approve order for NGN 105,000.00" }).isVisible());
  await check(page, "approval-review", vp, run);
  const q2 = await sup.a.call("POST", `/orgs/${sup.org}/requests/${requestId}/quotes`, quote(sup, { unitPrice: "2400.00", goodsTotal: "96000.00" }));
  assert.equal(q2.status, 201);
  await page.getByRole("button", { name: "Approve order for NGN 105,000.00" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve order for NGN 105,000.00" }).click();
  await page.getByText("Not approved: something changed").waitFor();
  assert.ok(await page.getByText("changed or replaced this quote", { exact: false }).isVisible());
  assert.ok(await page.getByText("No order was created", { exact: false }).isVisible());
  await check(page, "approval-rejected", vp, run);

  // fresh approval of the current version
  await page.getByRole("link", { name: "Review the current quotes" }).click();
  await heading("Compare quotes");
  await page.getByText("NGN 101,000.00").locator("visible=true").first().waitFor();
  await page.getByRole("button", { name: /Review and approve/ }).first().click();
  await heading("Review before you approve");
  await page.getByRole("button", { name: "Approve order for NGN 101,000.00" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve order for NGN 101,000.00" }).click();
  await heading("Order of NGN 101,000.00");
  await page.getByText("Waiting for supplier to accept").first().waitFor();
  await check(page, "order-awaiting", vp, run);
  const orderId = page.url().split("/").pop();

  // supplier accepts and delivers (API); the supplier's "delivered" is not completion
  assert.equal((await sup.a.call("POST", `/orgs/${sup.org}/orders/${orderId}/accept`, {})).status, 200);
  for (const to of ["preparing", "dispatched", "delivered"]) assert.equal((await sup.a.call("POST", `/orgs/${sup.org}/orders/${orderId}/progress`, { to })).status, 200);
  await page.reload();
  await page.getByText("Supplier says delivered: confirm receipt").first().waitFor();
  await check(page, "order-delivered", vp, run);

  // buyer reports a partial delivery; supplier disagrees; both versions stay visible; buyer closes with a note
  await page.getByLabel("Part of it").check();
  await page.getByLabel(/How much arrived/).fill("30");
  await page.getByLabel("What happened").fill("Only 30 L arrived");
  await page.getByRole("button", { name: "Send report" }).click();
  await page.getByText("Partly received").first().waitFor();
  assert.equal((await sup.a.call("POST", `/orgs/${sup.org}/orders/${orderId}/discrepancy-response`, { note: "Driver log shows 40 L delivered", quantity: "40" })).status, 200);
  await page.reload();
  await page.getByText("Reported problem: both sides are kept as written").waitFor();
  assert.ok(await page.getByText("Only 30 L arrived").first().isVisible());
  assert.ok(await page.getByText("Driver log shows 40 L delivered").first().isVisible());
  await check(page, "order-discrepancy", vp, run);
  await page.getByLabel("How it was settled").fill("Supplier will credit 10 L on the next order");
  await page.getByRole("button", { name: "Close with this note" }).click();
  await page.getByText("Completed", { exact: true }).first().waitFor();
  assert.ok(await page.getByText("Supplier will credit 10 L on the next order").first().isVisible());
  assert.ok(await page.getByText("Driver log shows 40 L delivered").first().isVisible(), "supplier's report still present after closing");

  // the evidence export downloads
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download evidence summary/ }).click()]);
  assert.match(dl.suggestedFilename(), /^supplypiper-order-.*\.json$/);

  await page.goto(BASE + "/app/suppliers"); await heading("Suppliers");
  await page.getByText("No completed orders recorded", { exact: false }).first().waitFor().catch(() => {});
  await check(page, "suppliers", vp, run);

  // The one deliberate 409 (approval refused because the quote changed) is logged by the browser as a failed resource; nothing else may be.
  const expected409 = run.errors.filter((e) => /status of 409/.test(e));
  assert.equal(expected409.length, 1, "exactly one expected 409 from the refused approval");
  assert.deepEqual(run.errors.filter((e) => !/status of 409/.test(e)), [], `unexpected console errors: ${run.errors.join(" | ")}`);
  await ctx.close();
  return run;
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
let failed = null;
try {
  for (const vp of VIEWPORTS) {
    const r = await journey(browser, vp); report.runs.push(r);
    console.log(`PASS buyer journey @${vp.w}: ${r.checks.length} screens, axe clean, no horizontal scroll, no console errors`);
  }
} catch (e) { failed = e; console.error("FAIL", e.message); } finally {
  await browser.close();
  writeFileSync(new URL("../../docs/e2e-results.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify({ ...report, failed: failed ? String(failed.message) : null }, null, 2));
  if (failed) process.exit(1);
}
