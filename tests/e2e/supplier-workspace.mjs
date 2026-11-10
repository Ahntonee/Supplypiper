// End-to-end SUPPLIER journey through the REAL UI against a RUNNING dev stack (API + web + dev DB, DEV_INBOX=true).
// The buyer acts through the real API. Run: node tests/e2e/supplier-workspace.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { Api, BASE, DAY, VIEWPORTS, check as baseCheck, iso, latestMailToken, localInput, signInUi, unique, verifiedUser } from "./lib.mjs";

const report = { checkedAt: new Date().toISOString(), runs: [] };
const check = (page, name, vp, run) => baseCheck(page, name, vp, run, "supplier");

async function buyerWorld(supplierOrgId, requestedQty = "40") {
  const { a, email } = await verifiedUser("buyer-for-supplier-ui");
  await a.login(email);
  const org = (await a.call("POST", "/orgs", { name: `E2E Buyer ${unique("b")}`, capabilities: ["buyer"] })).body.id;
  const rq = await a.call("POST", `/orgs/${org}/requests`, { category: "palm_oil", quantity: requestedQty, unit: "L", budget: "120000.00", currency: "NGN", deliverBy: iso(3 * DAY), deliverTz: "Africa/Lagos", destinationArea: "lagos-mainland", destinationAddress: "12 Allen Avenue, Ikeja", allowManualLane: true });
  assert.equal(rq.status, 201, JSON.stringify(rq.body));
  const pub = await a.call("POST", `/orgs/${org}/requests/${rq.body.id}/publish`, { supplierOrgIds: [supplierOrgId], responseDeadline: iso(DAY), confirmShare: true });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  return { a, org, requestId: rq.body.id };
}

async function journey(browser, vp) {
  const holder = {};
  try { return await inner(browser, vp, holder); } catch (e) {
    if (holder.page) {
      const p = `${tmpdir()}/e2e-supplier-fail-${vp.w}.png`;
      await holder.page.screenshot({ path: p, fullPage: true }).catch(() => {});
      console.error(`failure screenshot: ${p}  url: ${holder.page.url()}`);
    }
    throw e;
  }
}

async function inner(browser, vp, holder) {
  const run = { width: vp.w, checks: [], errors: [] };
  const { a: sup, email } = await verifiedUser(`supplier-ui${vp.w}`);
  await sup.login(email);
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); holder.page = page;
  page.on("console", (m) => m.type() === "error" && run.errors.push(m.text()));
  page.on("pageerror", (e) => run.errors.push(String(e)));
  const h1 = (name) => page.getByRole("heading", { name, level: 1 }).waitFor();
  const orgName = `E2E Palm Oil Supplier ${unique(String(vp.w))}`;

  // ---- onboarding as a supplier-only organisation
  await signInUi(page, email);
  await h1("Set up your organisation");
  await page.getByLabel("Organisation name").fill(orgName);
  await page.getByLabel("Buy supplies").uncheck();
  await page.getByLabel("Supply goods").check();
  await page.getByRole("button", { name: "Create organisation" }).click();
  await h1("Overview");
  await page.getByText("Buyers cannot invite you yet").waitFor();
  const supOrg = (await sup.call("GET", "/orgs")).body.organisations[0].id;

  // ---- profile (claimed details) and the honest identity section
  await page.getByRole("link", { name: "Create supplier profile" }).click();
  await h1("Supplier profile");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByText("Enter the area you deliver to").waitFor();
  await page.getByLabel("Area you deliver to").fill("lagos-mainland");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByText("Profile saved").waitFor();
  assert.ok(await page.getByText("Agent verification isn't switched on", { exact: false }).isVisible(), "identity section says verification is not available");
  assert.equal(await page.getByText("Not available yet").count(), 2, "both agent sections are marked not available");
  await check(page, "profile", vp, run);

  // ---- catalogue and a stock statement
  await page.goto(BASE + "/app/catalogue"); await h1("Catalogue and stock");
  await page.getByLabel("Name", { exact: true }).fill("Palm oil 25L");
  await page.getByLabel("Your usual price per unit (NGN)").fill("2500");
  await page.getByRole("button", { name: "Add product" }).click();
  await page.getByText("Product added", { exact: false }).waitFor();
  await page.getByLabel(/New total available now \(L\)/).fill("100");
  await page.getByRole("button", { name: "Record stock statement" }).click();
  await page.getByText("100 L", { exact: true }).waitFor();
  assert.ok(await page.getByText("Declared by you; not a guarantee", { exact: false }).isVisible());
  await check(page, "catalogue", vp, run);

  // ---- buyer publishes a request to this supplier (API); inbox shows it without the budget
  const buyer = await buyerWorld(supOrg);
  await page.goto(BASE + "/app/inbox"); await h1("Requests for quotes");
  await page.getByText("No quote yet").waitFor();
  assert.equal(await page.getByText(/120,000/).count(), 0, "buyer budget is never shown to a supplier");
  await check(page, "inbox", vp, run);

  // ---- a supplier-staff member can draft but not submit
  const staff = await verifiedUser("staff-ui");
  assert.equal((await sup.call("POST", `/orgs/${supOrg}/invitations`, { email: staff.email, role: "supplier_staff" })).status, 201);
  await staff.a.login(staff.email);
  assert.equal((await staff.a.call("POST", "/invitations/accept", { token: await latestMailToken(staff.email, "org_invitation") })).status, 200);
  const sctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const spage = await sctx.newPage();
  await signInUi(spage, staff.email);
  await spage.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await spage.goto(`${BASE}/app/inbox/${buyer.requestId}`);
  await spage.getByRole("button", { name: "Save draft" }).waitFor();
  assert.equal(await spage.getByRole("button", { name: "Submit quote" }).count(), 0, "staff cannot submit quotes");
  assert.ok(await spage.getByText("A supplier manager submits them", { exact: false }).isVisible());
  await sctx.close();

  // ---- the quote builder as the owner/manager
  await page.getByRole("link", { name: /palm oil, 40 L/i }).click();
  await h1(/palm oil, 40 L/i);
  await page.getByRole("heading", { name: "Your quote" }).waitFor();
  await page.getByRole("button", { name: "Submit quote" }).click(); // empty form: blocked with clear errors
  await page.getByText("Use an amount like 2500 or 2500.50").first().waitFor();
  await page.getByText("Enter the delivery charge, or 0 if there is none").waitFor();
  assert.equal(await page.getByText("Landed total the buyer will see").locator("..").getByText("Incomplete").count(), 1, "total is incomplete until charges are stated");
  await page.getByLabel("Product from your catalogue").selectOption({ label: "palm oil per L" });
  assert.equal(await page.getByLabel("Price per unit (NGN)").inputValue(), "2500.00", "price prefilled from the catalogue");
  assert.equal(await page.getByText("Use an amount like 2500 or 2500.50").count(), 0, "no stale error on a value filled in from the catalogue");
  await page.getByRole("button", { name: "Calculate from price" }).click();
  assert.equal(await page.getByLabel("Goods total (NGN)").inputValue(), "100000.00");
  await page.getByLabel("Delivery (NGN)").fill("5000");
  await page.getByLabel("Tax (NGN)").fill("0");
  await page.getByLabel("This quote is valid until").fill(localInput(2 * DAY));
  await page.getByLabel("Delivery promised by").fill(localInput(2 * DAY));
  await page.getByLabel("Payment terms").fill("Pay on delivery");
  await page.getByLabel("We deliver to lagos-mainland").check();
  await page.getByText("NGN 105,000.00").first().waitFor();
  // an unknown required charge is called out and makes the total incomplete
  await page.getByLabel("Not known yet").nth(1).check();
  await page.getByText("A required charge is marked unknown").waitFor();
  await page.getByLabel("Not known yet").nth(1).uncheck();
  await check(page, "quote-builder", vp, run);

  // save a draft (the buyer cannot see it), then submit that draft
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("Draft saved. The buyer cannot see it until a manager submits it.").waitFor();
  assert.equal((await buyer.a.call("GET", `/orgs/${buyer.org}/requests/${buyer.requestId}`)).body.quotesReceived, 0, "a draft is invisible to the buyer");
  await page.getByRole("button", { name: "Submit this draft v1" }).click();
  await page.getByText("Current", { exact: true }).waitFor();
  assert.equal((await buyer.a.call("GET", `/orgs/${buyer.org}/requests/${buyer.requestId}`)).body.quotesReceived, 1);

  // revise: a new version supersedes v1; v1 is kept in history
  await page.getByRole("heading", { name: /Revise your quote \(next version: v2\)/ }).waitFor();
  await page.getByLabel("Price per unit (NGN)").fill("2400");
  await page.getByRole("button", { name: "Calculate from price" }).click();
  await page.getByText("NGN 101,000.00").first().waitFor();
  await page.getByRole("button", { name: "Submit quote" }).click();
  await page.getByText("Quote submitted as a new version").waitFor();
  await page.getByText("Superseded", { exact: true }).waitFor();
  await check(page, "quote-history", vp, run);

  // ---- buyer compares and approves exactly the current version (API); the supplier sees an order to accept
  const cmp = (await buyer.a.call("POST", `/orgs/${buyer.org}/requests/${buyer.requestId}/comparisons`, {})).body;
  assert.equal(cmp.lanes.manual.length, 1);
  assert.equal(cmp.lanes.manual[0].landedTotal, "NGN 101,000.00");
  const intent = (await buyer.a.call("POST", `/orgs/${buyer.org}/requests/${buyer.requestId}/approval-intents`, { quoteVersionId: cmp.lanes.manual[0].quoteVersionId })).body;
  const conf = await buyer.a.call("POST", `/orgs/${buyer.org}/approvals/${intent.intentId}/confirm`, { expectedTotalMinor: intent.totalMinor });
  assert.equal(conf.status, 201, JSON.stringify(conf.body));
  const orderId = conf.body.orderId;

  await page.goto(BASE + "/app"); await h1("Overview");
  await page.getByText("Orders to accept").waitFor();
  await page.getByRole("link", { name: "Orders", exact: true }).first().click().catch(async () => { await page.goto(BASE + "/app/orders"); });
  await h1("Orders");
  await page.getByRole("link", { name: "Order of NGN 101,000.00" }).click();
  await h1("Order of NGN 101,000.00");
  await page.getByText("Waiting for supplier to accept").first().waitFor();
  assert.equal(await page.getByText(/120,000/).count(), 0, "order never exposes the buyer's budget to the supplier");
  await check(page, "order-to-accept", vp, run);

  // accept: stock is reserved
  await page.getByRole("button", { name: "Accept order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Accept order" }).click();
  await page.getByText("Accepted by supplier").first().waitFor();
  await page.goto(BASE + "/app/catalogue"); await h1("Catalogue and stock");
  await page.getByText("40 L", { exact: true }).waitFor(); // reserved
  await page.goBack(); await h1("Order of NGN 101,000.00");

  // fulfilment updates are the supplier's statements; the buyer still has to confirm receipt
  await page.getByRole("button", { name: "Mark as being prepared" }).click();
  await page.getByRole("button", { name: "Mark as dispatched" }).click();
  await page.getByRole("button", { name: "Report as delivered" }).click();
  await page.getByText("You have reported delivery. Waiting for the buyer to confirm receipt.").waitFor();
  await page.getByText("You marked the order as being prepared").waitFor(); // timeline wording agrees with its subject
  await page.getByText("You reported the goods as delivered", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: /confirm receipt/i }).count(), 0, "a supplier cannot confirm receipt");
  await check(page, "order-delivered-reported", vp, run);

  // buyer reports a partial delivery (API); supplier responds in the UI; both versions stay
  assert.equal((await buyer.a.call("POST", `/orgs/${buyer.org}/orders/${orderId}/receipt`, { outcome: "partial", receivedQuantity: "30", note: "Only 30 L arrived" })).status, 200);
  await page.reload();
  await page.getByText("Reported problem: both sides are kept as written").waitFor();
  await page.getByLabel("Your response").fill("Driver log shows 40 L delivered");
  await page.getByLabel(/Quantity you say was delivered/).fill("40");
  await check(page, "order-respond", vp, run);
  await page.getByRole("button", { name: "Send response" }).click();
  await page.getByText("Your response is recorded next to the buyer's report", { exact: false }).waitFor();
  assert.ok(await page.getByText("Only 30 L arrived").first().isVisible(), "buyer's report is still there");
  assert.ok(await page.getByText("Driver log shows 40 L delivered").first().isVisible());

  // ---- console hygiene: the only tolerated errors are the browser logging the deliberate "no profile yet" 404
  const unexpected = run.errors.filter((e) => !/status of 404/.test(e));
  assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.join(" | ")}`);
  assert.ok(run.errors.length <= 2, `too many 404 logs: ${run.errors.length}`);
  await ctx.close();
  return run;
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
let failed = null;
try {
  for (const vp of VIEWPORTS) {
    const r = await journey(browser, vp); report.runs.push(r);
    console.log(`PASS supplier journey @${vp.w}: ${r.checks.length} screens, axe clean, no horizontal scroll`);
  }
} catch (e) { failed = e; console.error("FAIL", e.message); } finally {
  await browser.close();
  writeFileSync(new URL("../../docs/e2e-supplier-results.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify({ ...report, failed: failed ? String(failed.message) : null }, null, 2));
  if (failed) process.exit(1);
}
void Api;
