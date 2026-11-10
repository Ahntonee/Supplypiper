// Shared helpers for the browser journeys. Requires a RUNNING dev stack (API + web + dev DB, DEV_INBOX=true).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";

export const BASE = process.env.WEB_URL ?? "http://localhost:5173";
export const OUT = new URL("../../docs/screenshots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT, { recursive: true });
export const PW = "correct-horse-battery";
export const DAY = 864e5;
export const VIEWPORTS = [{ w: 390, h: 844 }, { w: 768, h: 1024 }, { w: 1440, h: 1000 }];
export const iso = (ms) => new Date(Date.now() + ms).toISOString();
export const localInput = (ms) => { const d = new Date(Date.now() + ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
export const unique = (tag) => `${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** API client with its own cookie jar and CSRF token (the browser under test has a separate session). */
export class Api {
  cookie = ""; csrf = "";
  async call(method, path, body) {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { "x-csrf-token": this.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set?.startsWith("sp_session=") && !set.includes("sp_session=;")) this.cookie = set.split(";")[0];
    const t = await res.text();
    return { status: res.status, body: t ? JSON.parse(t) : null };
  }
  async login(email) { const l = await this.call("POST", "/auth/login", { email, password: PW }); assert.equal(l.status, 200); this.csrf = l.body.csrfToken; return this; }
}

export async function verifiedUser(label) {
  const a = new Api(); const email = `${unique(label)}@example.test`;
  await a.call("POST", "/auth/register", { email, password: PW, displayName: label });
  const inbox = await a.call("GET", `/dev/inbox?to=${encodeURIComponent(email)}`);
  assert.equal((await a.call("POST", "/auth/verify-email", { token: inbox.body.emails[0].data.token })).status, 200);
  return { a, email };
}

export async function latestMailToken(email, template) {
  const a = new Api();
  const inbox = await a.call("GET", `/dev/inbox?to=${encodeURIComponent(email)}`);
  const mail = inbox.body.emails.find((m) => m.template === template);
  assert.ok(mail, `no ${template} mail for ${email}`);
  return mail.data.token;
}

/** Wait for the page to settle, then assert: no horizontal scroll, zero axe violations; save a screenshot. */
export async function check(page, name, vp, run, prefix) {
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  await page.screenshot({ path: `${OUT}${prefix}-${name}-${vp.w}.png`, fullPage: true });
  run.checks.push({ screen: name, horizontalScroll: overflow, axeViolations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })) });
  assert.equal(overflow, false, `${name}@${vp.w}: unexpected horizontal scroll`);
  assert.equal(axe.violations.length, 0, `${name}@${vp.w}: axe violations ${JSON.stringify(axe.violations.map((v) => v.id))}`);
}

export async function signInUi(page, email) {
  await page.goto(BASE + "/login");
  await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sha = (b) => createHash("sha256").update(b).digest();
function b58(bytes) {
  let n = 0n; for (const x of bytes) n = (n << 8n) | BigInt(x);
  let out = ""; while (n > 0n) { out = ALPHA[Number(n % 58n)] + out; n /= 58n; }
  for (const x of bytes) { if (x === 0) out = "1" + out; else break; }
  return out;
}
/** A syntactically valid, unique token address in the TESTNET agent registry <12802,0> (Base58Check of 0x02 || ULEB(12802) || ULEB(0) || u64 LE). */
export function mintTestnetToken() {
  let t = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)); const id = [];
  for (let i = 0; i < 8; i++) { id.push(Number(t & 0xffn)); t >>= 8n; }
  const payload = Uint8Array.from([0x02, 0x82, 0x64, 0x00, ...id]);
  return b58(Uint8Array.from([...payload, ...sha(sha(payload)).subarray(0, 4)]));
}
