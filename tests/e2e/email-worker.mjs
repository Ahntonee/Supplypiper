// Email worker, notifications and account recovery in a REAL browser, with a REAL worker process delivering to the development inbox.
// Covers: queue state shown honestly before the worker runs, delivery, verify link, forgot/reset password, invitation acceptance (signed out then in),
// the notification bell and page, and organisation switching from a notification. No real email is sent: the dev provider stores messages in the database.
// Run: node --env-file=.env tests/e2e/email-worker.mjs   (API + web + dev DB running, DEV_INBOX=true, SUPPLYPIPER_MODE=demo)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { Api, BASE, DAY, PW, VIEWPORTS, check as baseCheck, iso, signInUi, unique, verifiedUser } from "./lib.mjs";

const check = (page, name, vp, run) => baseCheck(page, name, vp, run, "worker");
const report = { checkedAt: new Date().toISOString(), runs: [] };
const PW2 = "another-long-passphrase-9";

let worker = null; let workerLog = "";
async function ensureWorker() {
  if (worker) return;
  worker = spawn(process.execPath, ["--env-file=.env", "--import", "tsx", "apps/worker/src/worker.ts"], { env: { ...process.env, WORKER_POLL_MS: "250", WORKER_BATCH: "50", EMAIL_MODE: "dev" }, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (d) => { workerLog += d; }); worker.stderr.on("data", (d) => { workerLog += d; });
  for (let i = 0; i < 100 && !workerLog.includes("worker started"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(workerLog.includes("worker started"), `worker did not start:\n${workerLog}`);
}

async function journey(browser, vp) {
  const holder = {};
  try { return await inner(browser, vp, holder); } catch (e) {
    if (holder.page) { const p = `${tmpdir()}/e2e-worker-fail-${vp.w}.png`; await holder.page.screenshot({ path: p, fullPage: true }).catch(() => {}); console.error(`failure screenshot: ${p}  url: ${holder.page.url()}\nworker log:\n${workerLog.slice(-1500)}`); }
    throw e;
  }
}

async function inner(browser, vp, holder) {
  const run = { width: vp.w, checks: [], errors: [] };
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); holder.page = page;
  page.on("pageerror", (e) => run.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) run.errors.push(m.text()); });
  const h1 = (name) => page.getByRole("heading", { level: 1, name }).waitFor();

  // ---- 1. a new account: the verification email is queued, and the dev inbox says so honestly until the worker delivers it
  const email = `${unique("wk")}@example.test`;
  const a = new Api();
  assert.equal((await a.call("POST", "/auth/register", { email, password: PW, displayName: "Worker Tester" })).status, 202);
  await page.goto(`${BASE}/dev/inbox?to=${encodeURIComponent(email)}`);
  await h1("Development inbox");
  const row = page.locator("li", { hasText: "verify email" }).or(page.locator("li", { hasText: "Verify your email" })).first();
  await row.waitFor();
  if (!worker) {
    await row.locator("[data-state=pending]").waitFor();
    await page.getByText("Waiting for the email worker").waitFor();
    assert.equal(await page.getByRole("link", { name: "Open the link in this email" }).count(), 0, "no link is offered before the message is delivered");
    await check(page, "dev-inbox-waiting", vp, run);
    await ensureWorker();
  }
  await page.reload();
  await page.getByText("Delivered to this inbox").first().waitFor({ timeout: 20000 });
  await page.getByRole("heading", { level: 1, name: "Development inbox" }).waitFor();
  await check(page, "dev-inbox-delivered", vp, run);
  const subject = await page.locator("li").first().locator("p").first().innerText();
  assert.ok(subject.startsWith("[Demo] "), `subject carries the environment label: ${subject}`);
  await page.getByRole("link", { name: "Open the link in this email" }).first().click();
  await page.getByText("Email verified").waitFor();

  // ---- 2. forgot password, from the sign-in page, through the delivered email, to signing in with the new password
  await page.goto(BASE + "/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await h1("Reset your password");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await page.getByText("Enter a valid email address").waitFor();
  await check(page, "forgot-password", vp, run);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await h1("Check your email");
  await page.getByText("If an account exists for that address").waitFor(); // identical wording whether or not the account exists
  await page.getByRole("link", { name: "development inbox" }).click();
  await page.locator("li", { hasText: "Reset your SupplyPiper password" }).getByRole("link", { name: "Open the link in this email" }).waitFor({ timeout: 20000 });
  await page.locator("li", { hasText: "Reset your SupplyPiper password" }).getByRole("link", { name: "Open the link in this email" }).click();
  await h1("Choose a new password");
  await page.getByLabel("New password", { exact: true }).fill(PW2);
  await page.getByLabel("Repeat the new password").fill(PW2 + "x");
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByText("The two passwords do not match").waitFor();
  await check(page, "reset-password", vp, run);
  await page.getByLabel("Repeat the new password").fill(PW2);
  await page.getByRole("button", { name: "Change password" }).click();
  await h1("Password changed");
  assert.equal((await new Api().call("POST", "/auth/login", { email, password: PW })).status, 401, "the old password no longer works");
  await page.getByRole("link", { name: "Continue to sign in" }).click();
  await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(PW2);
  await page.getByRole("button", { name: "Sign in" }).click();
  await h1(/Overview|Set up your organisation/); // a brand-new account has no organisation yet
  // a used reset link fails clearly
  const devInbox = await a.call("GET", `/dev/inbox?to=${encodeURIComponent(email)}`);
  const resetTok = devInbox.body.emails.find((m) => m.template === "password_reset").data.token;
  await page.goto(`${BASE}/reset-password?token=${encodeURIComponent(resetTok)}`);
  await page.getByLabel("New password", { exact: true }).fill("yet-another-passphrase-1"); await page.getByLabel("Repeat the new password").fill("yet-another-passphrase-1");
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByText("This link did not work").waitFor();
  // that reset signed out every session, including this browser's: sign back in for the next steps
  await signInUiWith(page, email, PW2);

  // ---- 3. invitation: an organisation owner invites this address; the link works signed out (sign in first) and signed in
  const { a: owner, email: ownerEmail } = await verifiedUser("wk-owner"); await owner.login(ownerEmail);
  const invOrg = (await owner.call("POST", "/orgs", { name: `E2E Invite Org ${unique("i")}`, capabilities: ["buyer"] })).body.id;
  assert.equal((await owner.call("POST", `/orgs/${invOrg}/invitations`, { email, role: "buyer_requester" })).status, 201);
  const inv = page.locator("li", { hasText: "invited to an organisation" });
  await page.goto(`${BASE}/dev/inbox?to=${encodeURIComponent(email)}`);
  await inv.getByRole("link", { name: "Open the link in this email" }).waitFor({ timeout: 20000 });
  const href = await inv.getByRole("link", { name: "Open the link in this email" }).getAttribute("href");
  const anon = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const apage = await anon.newPage();
  await apage.goto(BASE + href);
  await apage.getByRole("heading", { level: 1, name: "Sign in to accept" }).waitFor();
  await check(apage, "accept-signed-out", vp, run);
  await apage.getByRole("link", { name: "Sign in", exact: true }).click();
  await apage.getByLabel("Email").fill(email); await apage.getByLabel("Password").fill(PW2);
  await apage.getByRole("button", { name: "Sign in" }).click();
  await apage.getByRole("heading", { level: 1, name: "Accept the invitation" }).waitFor(); // returned to the invitation after signing in
  await check(apage, "accept-signed-in", vp, run);
  await apage.getByRole("button", { name: "Join the organisation" }).click();
  await apage.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
  const orgsNow = (await new Api().login2(email, PW2)).organisations;
  assert.ok(orgsNow.some((o) => o.id === invOrg), "the invitee is now a member");
  await anon.close();
  await page.goto(BASE + href); // second use of the same link
  await page.getByRole("button", { name: "Join the organisation" }).click();
  await page.getByText("invalid, expired, already used").waitFor();

  // ---- 4. notifications: a supplier is invited to quote, sees the bell, opens the notice, and the count drops
  const { a: sup, email: supEmail } = await verifiedUser("wk-sup"); await sup.login(supEmail);
  const supOrg = (await sup.call("POST", "/orgs", { name: `E2E Notice Oils ${unique("n")}`, capabilities: ["supplier"] })).body.id;
  assert.equal((await sup.call("PUT", `/orgs/${supOrg}/supplier-profile`, { category: "palm_oil", areaCode: "lagos-mainland" })).status, 200);
  const otherOrg = (await sup.call("POST", "/orgs", { name: `E2E Other Org ${unique("o")}`, capabilities: ["buyer"] })).body.id;
  const { a: buyer, email: buyerEmail } = await verifiedUser("wk-buyer"); await buyer.login(buyerEmail);
  const buyerOrg = (await buyer.call("POST", "/orgs", { name: `E2E Notice Buyer ${unique("b")}`, capabilities: ["buyer"] })).body.id;
  const rq = await buyer.call("POST", `/orgs/${buyerOrg}/requests`, { category: "palm_oil", quantity: "40", unit: "L", budget: "120000.00", currency: "NGN", deliverBy: iso(3 * DAY), deliverTz: "Africa/Lagos", destinationArea: "lagos-mainland", destinationAddress: "12 Allen Avenue, Ikeja", allowManualLane: true });
  assert.equal((await buyer.call("POST", `/orgs/${buyerOrg}/requests/${rq.body.id}/publish`, { supplierOrgIds: [supOrg], responseDeadline: iso(DAY), confirmShare: true })).status, 200);
  const ctx2 = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
  const sp = await ctx2.newPage(); holder.page = sp;
  await signInUi(sp, supEmail);
  await sp.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
  await sp.evaluate(([o]) => localStorage.setItem("sp.activeOrg", o), [otherOrg]); // the person is working in a different organisation right now
  await sp.reload();
  await sp.getByRole("link", { name: "Notifications, 1 unread" }).waitFor({ timeout: 15000 });
  await check(sp, "bell-unread", vp, run);
  await sp.getByRole("link", { name: /^Notifications/ }).click();
  await sp.getByRole("heading", { level: 1, name: "Notifications" }).waitFor();
  await sp.getByText("New request to quote").waitFor();
  await sp.getByText("Unread", { exact: true }).waitFor();
  assert.equal(await sp.getByText(/120000|120,000|budget|Allen Avenue/i).count(), 0, "a notification never carries the buyer's budget or address");
  await check(sp, "notifications", vp, run);
  await sp.getByRole("button", { name: "Open: New request to quote" }).click();
  await sp.waitForURL(new RegExp(`/app/inbox/${rq.body.id}`));
  await sp.getByRole("heading", { level: 1 }).first().waitFor();
  assert.equal(await sp.locator("#org").inputValue(), supOrg, "opening a notice switches to the organisation it belongs to");
  await sp.getByRole("link", { name: "Notifications", exact: true }).waitFor(); // no unread badge any more
  await sp.goto(BASE + "/app/notifications");
  await sp.getByText("Unread", { exact: true }).waitFor({ state: "detached" });
  await check(sp, "notifications-read", vp, run);
  // the email copy of the same event arrives through the worker, free of prices and addresses
  const sent = await new Api().call("GET", `/dev/inbox?to=${encodeURIComponent(supEmail)}`);
  const rfqMail = sent.body.emails.find((m) => m.template === "rfq_invited");
  await (async () => { for (let i = 0; i < 80 && !(await new Api().call("GET", `/dev/inbox?to=${encodeURIComponent(supEmail)}`)).body.emails.find((m) => m.template === "rfq_invited" && m.state === "delivered"); i++) await new Promise((r) => setTimeout(r, 250)); })();
  const final = (await new Api().call("GET", `/dev/inbox?to=${encodeURIComponent(supEmail)}`)).body.emails.find((m) => m.template === "rfq_invited");
  assert.equal(final.state, "delivered");
  assert.ok(rfqMail, "event existed");
  assert.ok(!/120000|120,000|budget|Allen Avenue|NGN/i.test(final.rendered.text), "the email contains no budget, address or price");
  await ctx2.close();

  assert.deepEqual(run.errors, [], `browser errors: ${run.errors.join(" | ")}`);
  await ctx.close();
  return run;
}

async function signInUiWith(page, email, password) {
  await page.goto(BASE + "/login");
  await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { level: 1, name: /Overview|Set up your organisation/ }).waitFor();
}

Api.prototype.login2 = async function (email, password) {
  const l = await this.call("POST", "/auth/login", { email, password }); assert.equal(l.status, 200); this.csrf = l.body.csrfToken;
  return (await this.call("GET", "/orgs")).body;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const vp of VIEWPORTS) { console.log(`\n=== viewport ${vp.w} ===`); report.runs.push(await journey(browser, vp)); console.log(`  ok: ${report.runs.at(-1).checks.length} checks`); }
  const bad = report.runs.flatMap((r) => r.checks).filter((c) => c.horizontalScroll || c.axeViolations.length);
  assert.equal(bad.length, 0);
  console.log("\nALL JOURNEYS PASSED (email worker, recovery, invitations, notifications)");
} finally {
  await browser.close();
  if (worker) { worker.kill(); }
}
