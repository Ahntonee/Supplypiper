// Buyer side of agent accountability in a REAL browser: verified lane + evidence, an excluded agent, approval with a commit-time check.
// Agent-sourced quotes cannot yet be created through the product (the quoting agent is a later stage), so the two quotes are inserted
// straight into the dev database, as the integration tests do. This environment's checker is the labelled SIMULATED demo checker.
// Run: node --env-file=.env tests/e2e/verified-lane.mjs   (API + web + dev DB running, DEV_INBOX=true, VERIFICATION_ADAPTER=mock)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";
import { BASE, DAY, VIEWPORTS, check as baseCheck, iso, mintTestnetToken, signInUi, unique, verifiedUser } from "./lib.mjs";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://supplypiper:devonly@127.0.0.1:54329/supplypiper_dev" } } });
const check = (page, name, vp, run) => baseCheck(page, name, vp, run, "verified-lane");
const report = { checkedAt: new Date().toISOString(), runs: [] };
const OWNER = "3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB";

async function supplier(label) {
  const { a, email } = await verifiedUser(label); await a.login(email);
  const userId = (await a.call("GET", "/auth/me")).body.user.id;
  const name = `E2E ${label} ${unique("s")}`;
  const org = (await a.call("POST", "/orgs", { name, capabilities: ["supplier"] })).body.id;
  assert.equal((await a.call("PUT", `/orgs/${org}/supplier-profile`, { category: "palm_oil", areaCode: "lagos-mainland" })).status, 200);
  return { a, org, userId, name };
}
async function agent(s, authorised, operatorType) {
  return prisma.agentRegistration.create({ data: {
    orgId: s.org, operatorType, network: "testnet", registry: "12802,0", tokenAddress: mintTestnetToken(), ownerAccount: OWNER, ownerProvedAt: new Date(), ownerProofUserId: s.userId, registeredByUserId: s.userId,
    orgAuthorityBoundAt: authorised ? new Date() : null, orgAuthorityBoundBy: authorised ? s.userId : null, orgAuthorityOwnerAccount: authorised ? OWNER : null,
  } });
}
async function agentQuote(requestId, s, agentId, goods) {
  const q = await prisma.quote.create({ data: { requestId, supplierOrgId: s.org, state: "submitted" } });
  await prisma.quoteVersion.create({ data: {
    quoteId: q.id, version: 1, source: "supplier_agent", authorUserId: s.userId, agentId, currency: "NGN", category: "palm_oil", priceUnit: "L", deliversToArea: true,
    offeredScaled: 40_000_000n, offeredUnit: "L", unitPriceMinor: goods / 40n, goodsTotalMinor: goods,
    charges: [{ kind: "delivery", label: "Delivery", amountMinor: "500000", mandatory: true }, { kind: "tax", label: "VAT", amountMinor: "0", mandatory: true }],
    validUntil: new Date(Date.now() + 2 * DAY), deliveryPromisedBy: new Date(Date.now() + 2 * DAY), deliveryTz: "Africa/Lagos", paymentTerms: "On delivery", submittedAt: new Date() } });
}

async function journey(browser, vp) {
  const holder = {};
  try { return await inner(browser, vp, holder); } catch (e) {
    if (holder.page) { const p = `${tmpdir()}/e2e-lane-fail-${vp.w}.png`; await holder.page.screenshot({ path: p, fullPage: true }).catch(() => {}); console.error(`failure screenshot: ${p}  url: ${holder.page.url()}`); }
    throw e;
  }
}

async function inner(browser, vp, holder) {
  const run = { width: vp.w, checks: [], errors: [] };
  const good = await supplier("lane-good"); const weak = await supplier("lane-noauth");
  const goodAgent = await agent(good, true, "platform_operated"); const weakAgent = await agent(weak, false, "supplier_owned");
  const { a: buyer, email } = await verifiedUser("lane-buyer"); await buyer.login(email);
  const buyerOrg = (await buyer.call("POST", "/orgs", { name: `E2E Lane Buyer ${unique("b")}`, capabilities: ["buyer"] })).body.id;
  const rq = await buyer.call("POST", `/orgs/${buyerOrg}/requests`, { category: "palm_oil", quantity: "40", unit: "L", budget: "120000.00", currency: "NGN", deliverBy: iso(3 * DAY), deliverTz: "Africa/Lagos", destinationArea: "lagos-mainland", destinationAddress: "12 Allen Avenue, Ikeja", allowManualLane: true });
  assert.equal((await buyer.call("POST", `/orgs/${buyerOrg}/requests/${rq.body.id}/publish`, { supplierOrgIds: [good.org, weak.org], responseDeadline: iso(DAY), confirmShare: true })).status, 200);
  await agentQuote(rq.body.id, good, goodAgent.id, 10_000_000n); await agentQuote(rq.body.id, weak, weakAgent.id, 9_000_000n);
  await prisma.procurementRequest.update({ where: { id: rq.body.id }, data: { state: "collecting" } });

  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); holder.page = page;
  page.on("console", (m) => m.type() === "error" && run.errors.push(m.text()));
  page.on("pageerror", (e) => run.errors.push(String(e)));
  await signInUi(page, email);
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await page.goto(`${BASE}/app/requests/${rq.body.id}/compare`);
  await page.getByRole("heading", { name: "Compare quotes", level: 1 }).waitFor();

  // the qualifying agent quote is in the verified lane, with identity and authority reported separately and the limits spelled out
  const card = page.getByRole("article", { name: `Verified-agent quote from ${good.name}` });
  await card.waitFor();
  await card.getByText("NGN 105,000.00").first().waitFor();
  await card.getByText("Simulated result").first().waitFor(); // this environment's checker is the labelled demo simulation
  await card.getByText("authorised by organisation", { exact: false }).first().waitFor();
  assert.ok(await card.getByText("Operated by the SupplyPiper platform", { exact: false }).first().isVisible(), "platform operation is disclosed to the buyer");
  assert.ok(await card.getByText("Endorsement by Concordium").first().isVisible(), "what verification does not establish is shown");
  assert.equal(await page.getByRole("article", { name: `Verified-agent quote from ${weak.name}` }).count(), 0, "an unauthorised agent is not in the verified lane");

  // the other agent is excluded, and the reason is authority, not identity
  await page.getByRole("heading", { name: weak.name }).waitFor();
  await page.getByText("has not authorised this agent to quote for it", { exact: false }).waitFor();
  await page.getByText("not authorised by the supplier organisation", { exact: false }).waitFor();
  await check(page, "compare-evidence", vp, run);

  // approve the verified quote: the server re-checks identity at commit and records the result on the order
  await card.getByRole("button", { name: /Review and approve/ }).click();
  await page.getByRole("heading", { name: "Review before you approve", level: 1 }).waitFor();
  await page.getByText("re-checked when you confirm", { exact: false }).waitFor();
  await check(page, "approval-agent", vp, run);
  await page.getByRole("button", { name: "Approve order for NGN 105,000.00" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve order for NGN 105,000.00" }).click();
  await page.getByRole("heading", { name: "Order of NGN 105,000.00", level: 1 }).waitFor();
  await page.getByText(/Agent identity verified on demo \(SIMULATED, demo only\)/).waitFor();
  assert.ok(await page.getByText("does not establish quality, registration, fulfilment ability or solvency", { exact: false }).first().isVisible());
  await check(page, "order-agent-evidence", vp, run);

  assert.deepEqual(run.errors, [], `console errors: ${run.errors.join(" | ")}`);
  await ctx.close();
  return run;
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
let failed = null;
try {
  for (const vp of VIEWPORTS) { const r = await journey(browser, vp); report.runs.push(r); console.log(`PASS verified-lane journey @${vp.w}: ${r.checks.length} screens, axe clean, no horizontal scroll, no console errors`); }
} catch (e) { failed = e; console.error("FAIL", e.message); } finally {
  await browser.close(); await prisma.$disconnect();
  writeFileSync(new URL("../../docs/e2e-verified-lane-results.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify({ ...report, failed: failed ? String(failed.message) : null }, null, 2));
  if (failed) process.exit(1);
}
