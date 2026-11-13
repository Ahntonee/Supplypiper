// AI features in a REAL browser, in this environment as it is: NO AI provider is configured, so the assistant must say so honestly
// while everything else works. Also the supplier's rule-based quote agent end to end.
// An agent registration is inserted straight into the dev database (the on-chain proof flow is covered elsewhere).
// Run: node --env-file=.env tests/e2e/ai-features.mjs   (API + web + dev DB running; AI_PROVIDER unset or none; VERIFICATION_ADAPTER=mock)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";
import { BASE, DAY, VIEWPORTS, check as baseCheck, iso, mintTestnetToken, signInUi, unique, verifiedUser } from "./lib.mjs";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://supplypiper:devonly@127.0.0.1:54329/supplypiper_dev" } } });
const check = (page, name, vp, run) => baseCheck(page, name, vp, run, "ai");
const report = { checkedAt: new Date().toISOString(), runs: [] };
const OWNER = "3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB";

async function journey(browser, vp) {
  const holder = {};
  try { return await inner(browser, vp, holder); } catch (e) {
    if (holder.page) { const p = `${tmpdir()}/e2e-ai-fail-${vp.w}.png`; await holder.page.screenshot({ path: p, fullPage: true }).catch(() => {}); console.error(`failure screenshot: ${p}  url: ${holder.page.url()}`); }
    throw e;
  }
}

async function inner(browser, vp, holder) {
  const run = { width: vp.w, checks: [], errors: [] };
  assert.equal((await fetch(`${BASE}/api/v1/environment`).then((r) => r.json())).aiAvailable, false, "this journey expects an environment with no AI provider");

  // supplier with an authorised agent, a product and stock
  const { a: sup, email: supEmail } = await verifiedUser("ai-sup"); await sup.login(supEmail);
  const supUser = (await sup.call("GET", "/auth/me")).body.user.id;
  const supName = `E2E AI Oils ${unique("s")}`;
  const supOrg = (await sup.call("POST", "/orgs", { name: supName, capabilities: ["supplier"] })).body.id;
  assert.equal((await sup.call("PUT", `/orgs/${supOrg}/supplier-profile`, { category: "palm_oil", areaCode: "Lagos Mainland" })).status, 200);
  const product = (await sup.call("POST", `/orgs/${supOrg}/products`, { name: "Palm oil 25L", category: "palm_oil", unit: "L", priceBasis: "per litre", unitPrice: "2500.00" })).body.id;
  assert.equal((await sup.call("POST", `/orgs/${supOrg}/products/${product}/inventory`, { available: "100" })).status, 201);
  const agent = await prisma.agentRegistration.create({ data: { orgId: supOrg, operatorType: "platform_operated", network: "testnet", registry: "12802,0", tokenAddress: mintTestnetToken(), ownerAccount: OWNER, ownerProvedAt: new Date(), ownerProofUserId: supUser, registeredByUserId: supUser, orgAuthorityBoundAt: new Date(), orgAuthorityBoundBy: supUser, orgAuthorityOwnerAccount: OWNER } });

  // buyer, two published requests: one the supplier can serve, one in another area
  const { a: buyer, email: buyerEmail } = await verifiedUser("ai-buyer"); await buyer.login(buyerEmail);
  const buyerOrg = (await buyer.call("POST", "/orgs", { name: `E2E AI Buyer ${unique("b")}`, capabilities: ["buyer"] })).body.id;
  const publish = async (area) => {
    const rq = await buyer.call("POST", `/orgs/${buyerOrg}/requests`, { category: "palm_oil", quantity: "40", unit: "L", budget: "120000.00", currency: "NGN", deliverBy: iso(3 * DAY), deliverTz: "Africa/Lagos", destinationArea: area, destinationAddress: "12 Allen Avenue, Ikeja", allowManualLane: true });
    assert.equal((await buyer.call("POST", `/orgs/${buyerOrg}/requests/${rq.body.id}/publish`, { supplierOrgIds: [supOrg], responseDeadline: iso(DAY), confirmShare: true })).status, 200);
    return rq.body.id;
  };
  const served = await publish("lagos mainland"); const elsewhere = await publish("Abuja");

  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); holder.page = page;
  page.on("console", (m) => m.type() === "error" && run.errors.push(m.text()));
  page.on("pageerror", (e) => run.errors.push(String(e)));
  const h1 = (name) => page.getByRole("heading", { name, level: 1 }).waitFor();

  // ---- supplier: configure the quote agent
  await signInUi(page, supEmail);
  await h1("Overview");
  await page.goto(`${BASE}/app/quote-agent`); await h1("Quote agent");
  await page.getByText("Rule-based, no AI model").first().waitFor();
  await page.getByRole("button", { name: "Save quote agent settings" }).click(); // switched off and empty: saves as a disabled config
  await page.getByText("Quote agent settings saved.").waitFor();
  await page.getByLabel("Switch the quote agent on").check();
  await page.getByLabel("Agent that quotes for you").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Save quote agent settings" }).click();
  await page.getByText("Choose at least one product.").waitFor(); // enabling without a product is blocked with a clear reason
  await page.getByLabel("Palm oil 25L (per L)").check();
  await page.getByLabel("Markup on your catalogue price (%)").fill("2");
  await page.getByLabel("Delivery charge (NGN)").fill("5000");
  await check(page, "quote-agent-settings", vp, run);
  await page.getByRole("button", { name: "Save quote agent settings" }).click();
  await page.getByText("Quote agent settings saved.").waitFor();

  // ---- supplier: the agent drafts from rules; a person reviews and submits
  await page.goto(`${BASE}/app/inbox/${served}`);
  await page.getByRole("heading", { name: "Quote agent", level: 2 }).waitFor();
  await page.getByRole("button", { name: "Prepare a draft with the quote agent" }).click();
  await page.getByText("No AI model set the price", { exact: false }).first().waitFor();
  await page.getByText("2,550.00", { exact: false }).first().waitFor();
  await page.getByRole("button", { name: "Submit this draft v1" }).waitFor();
  assert.equal((await buyer.call("GET", `/orgs/${buyerOrg}/requests/${served}`)).body.quotesReceived, 0, "the draft is invisible to the buyer until a person submits it");
  await check(page, "quote-agent-draft", vp, run);
  await page.getByRole("button", { name: "Submit this draft v1" }).click();
  await page.getByText("Current", { exact: true }).waitFor();
  assert.equal((await buyer.call("GET", `/orgs/${buyerOrg}/requests/${served}`)).body.quotesReceived, 1);

  // ---- supplier: refusal instead of guessing
  await page.goto(`${BASE}/app/inbox/${elsewhere}`);
  await page.getByRole("button", { name: "Prepare a draft with the quote agent" }).click();
  await page.getByText("could not prepare a quote", { exact: false }).waitFor();
  await page.getByText("The delivery area is not the area you deliver to.").waitFor();
  await check(page, "quote-agent-refused", vp, run);

  // ---- buyer: AI assistant honestly unavailable; the form still works; rule-based explanation; agent quote in the verified lane
  const bctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const bpage = await bctx.newPage(); holder.page = bpage;
  bpage.on("console", (m) => m.type() === "error" && run.errors.push(m.text()));
  await signInUi(bpage, buyerEmail);
  await bpage.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await bpage.goto(`${BASE}/app/requests/new`);
  await bpage.getByRole("heading", { name: "New request", level: 1 }).waitFor();
  await bpage.getByText("AI assistant unavailable", { exact: true }).first().waitFor();
  assert.equal(await bpage.getByRole("button", { name: /Fill the form from this description/ }).count(), 0, "no AI button is offered when there is no AI");
  assert.ok(await bpage.getByLabel("Quantity").isVisible(), "the manual form is fully there");
  await check(bpage, "new-request-no-ai", vp, run);

  await bpage.goto(`${BASE}/app/requests/${served}/compare`);
  await bpage.getByRole("heading", { name: "Compare quotes", level: 1 }).waitFor();
  const card = bpage.getByRole("article", { name: `Verified-agent quote from ${supName}` });
  await card.waitFor();
  await card.getByText("NGN 107,000.00").first().waitFor(); // 40 L x 2,550.00 + 5,000.00 delivery, exactly
  await card.getByText("Operated by the SupplyPiper platform", { exact: false }).first().waitFor();
  await bpage.getByRole("button", { name: "Explain in plain words" }).click();
  await bpage.getByText("By SupplyPiper's rules, not AI.").waitFor();
  await bpage.getByText("AI assistant unavailable").first().waitFor();
  assert.equal(await bpage.getByText("AI summary", { exact: true }).count(), 0, "no AI summary is invented when there is no AI");
  assert.ok(await bpage.getByText(supName, { exact: false }).first().isVisible());
  await check(bpage, "compare-explain-rules", vp, run);

  const unexpected = run.errors.filter((e) => !/status of 409/.test(e));
  assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.join(" | ")}`);
  assert.ok(run.errors.length <= 1, "only the deliberate refusal may be logged");
  await ctx.close(); await bctx.close();
  void agent;
  return run;
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
let failed = null;
try {
  for (const vp of VIEWPORTS) { const r = await journey(browser, vp); report.runs.push(r); console.log(`PASS ai-features journey @${vp.w}: ${r.checks.length} screens, axe clean, no horizontal scroll`); }
} catch (e) { failed = e; console.error("FAIL", e.message); } finally {
  await browser.close(); await prisma.$disconnect();
  writeFileSync(new URL("../../docs/e2e-ai-results.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify({ ...report, failed: failed ? String(failed.message) : null }, null, 2));
  if (failed) process.exit(1);
}
