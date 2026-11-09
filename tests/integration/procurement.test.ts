import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://supplypiper:devonly@127.0.0.1:54329/supplypiper_test";
const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
let dbUp = false;
try { await prisma.$queryRaw`SELECT 1`; dbUp = true; } catch { /* reported as SKIPPED */ }
if (!dbUp) console.warn("SKIPPED: procurement integration tests need PostgreSQL at TEST_DATABASE_URL (run `npm run db:dev`).");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!dbUp)("procurement workflow, two organisations, real PostgreSQL", () => {
  let base = "";
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  beforeAll(() => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe", shell: true });
    const config = loadConfig({ SUPPLYPIPER_MODE: "demo", VERIFICATION_ADAPTER: "mock", DATABASE_URL: DB_URL });
    server = createApp({ config, prisma, checkReady: async () => true }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => { server?.close(); await prisma.$disconnect(); });

  class Client {
    cookie = ""; csrf = ""; userId = ""; email = "";
    async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
      const res = await fetch(base + path, {
        method, headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { "x-csrf-token": this.csrf } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set?.startsWith("sp_session=") && !set.includes("sp_session=;")) this.cookie = set.split(";")[0]!;
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    }
  }
  const PW = "correct-horse-battery";
  async function emailToken(to: string, template: string): Promise<string> {
    const ev = await prisma.outboxEvent.findFirst({ where: { topic: "email", payload: { path: ["to"], equals: to } }, orderBy: { createdAt: "desc" } });
    const p = ev?.payload as { template: string; data: { token: string } } | undefined;
    expect(p?.template).toBe(template);
    return p!.data.token;
  }
  async function user(label: string): Promise<Client> {
    const c = new Client(); c.email = `${label}-${randomUUID()}@example.test`;
    await c.call("POST", "/auth/register", { email: c.email, password: PW, displayName: label });
    await c.call("POST", "/auth/verify-email", { token: await emailToken(c.email, "verify_email") });
    const l = await c.call("POST", "/auth/login", { email: c.email, password: PW });
    c.csrf = l.body.csrfToken; c.userId = l.body.user.id;
    return c;
  }
  async function org(c: Client, name: string, cap: "buyer" | "supplier"): Promise<string> {
    return (await c.call("POST", "/orgs", { name, capabilities: [cap] })).body.id;
  }
  async function addMember(owner: Client, orgId: string, role: string, label: string): Promise<Client> {
    const m = await user(label);
    await owner.call("POST", `/orgs/${orgId}/invitations`, { email: m.email, role });
    expect((await m.call("POST", "/invitations/accept", { token: await emailToken(m.email, "org_invitation") })).status).toBe(200);
    return m;
  }

  const DAY = 86_400_000;
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  /** Reference scenario world: buyer org, invited supplier with 100 L declared, an un-invited supplier. */
  async function world() {
    const buyer = await user("buyer"); const sup = await user("sup"); const other = await user("other-sup");
    const buyerOrg = await org(buyer, "Mama Put Kitchen", "buyer");
    const supOrg = await org(sup, "Palm Oil Traders", "supplier");
    const otherOrg = await org(other, "Uninvited Oils", "supplier");
    for (const [c, o] of [[sup, supOrg], [other, otherOrg]] as const) {
      expect((await c.call("PUT", `/orgs/${o}/supplier-profile`, { category: "palm_oil", areaCode: "lagos-mainland" })).status).toBe(200);
    }
    const product = (await sup.call("POST", `/orgs/${supOrg}/products`, { name: "Palm oil 25L", category: "palm_oil", unit: "L", priceBasis: "per litre, ex-delivery", unitPrice: "2500.00" })).body;
    expect((await sup.call("POST", `/orgs/${supOrg}/products/${product.id}/inventory`, { available: "100" })).status).toBe(201);
    return { buyer, sup, other, buyerOrg, supOrg, otherOrg, productId: product.id as string };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const requestBody = (over: Json = {}) => ({
    category: "palm_oil", quantity: "40", unit: "L", budget: "120000.00", deliverBy: iso(3 * DAY), deliverTz: "Africa/Lagos",
    destinationArea: "lagos-mainland", destinationAddress: "12 Allen Avenue, Ikeja", allowManualLane: true, ...over,
  });
  async function publishedRequest(w: W, over: Json = {}): Promise<string> {
    const created = await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests`, requestBody(over));
    expect(created.status).toBe(201);
    const pub = await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${created.body.id}/publish`, { supplierOrgIds: [w.supOrg], responseDeadline: iso(DAY), confirmShare: true });
    expect(pub.status).toBe(200);
    return created.body.id;
  }
  const quoteBody = (w: W, over: Json = {}) => ({
    productId: w.productId, category: "palm_oil", offeredQuantity: "40", offeredUnit: "L", unitPrice: "2500.00", priceUnit: "L", goodsTotal: "100000.00",
    charges: [{ kind: "delivery", label: "Delivery", amount: "5000.00", mandatory: true }, { kind: "tax", label: "VAT", amount: "0.00", mandatory: true }],
    validUntil: iso(2 * DAY), deliveryPromisedBy: iso(2 * DAY), deliveryTz: "Africa/Lagos", paymentTerms: "Pay on delivery", deliversToArea: true, submit: true, ...over,
  });
  async function submitQuote(w: W, requestId: string, over: Json = {}) {
    const r = await w.sup.call("POST", `/orgs/${w.supOrg}/requests/${requestId}/quotes`, quoteBody(w, over));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  }
  async function intent(w: W, requestId: string, quoteVersionId: string) {
    return w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${requestId}/approval-intents`, { quoteVersionId });
  }
  const confirm = (w: W, i: Json) => w.buyer.call("POST", `/orgs/${w.buyerOrg}/approvals/${i.intentId}/confirm`, { expectedTotalMinor: i.totalMinor });

  async function toOrder(w: W, qty = "40", total = "100000.00") {
    const rid = await publishedRequest(w, { quantity: qty, budget: "300000.00" });
    const q = await submitQuote(w, rid, { offeredQuantity: qty, goodsTotal: total, unitPrice: "2500.00" });
    const i = (await intent(w, rid, q.id)).body;
    const c = await confirm(w, i);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    return { rid, q, orderId: c.body.orderId as string };
  }

  it("reference scenario: 40 L, NGN 120,000 budget, human approval, supplier acceptance, buyer receipt", async () => {
    const w = await world();
    const rid = await publishedRequest(w);

    // supplier sees the request but never the buyer's budget; the uninvited supplier sees nothing and cannot quote
    const inbox = (await w.sup.call("GET", `/orgs/${w.supOrg}/inbox`)).body.requests as Json[];
    expect(inbox.map((x) => x.id)).toContain(rid);
    expect(JSON.stringify(inbox)).not.toMatch(/budget/i);
    expect(((await w.other.call("GET", `/orgs/${w.otherOrg}/inbox`)).body.requests as Json[]).length).toBe(0);
    expect((await w.other.call("POST", `/orgs/${w.otherOrg}/requests/${rid}/quotes`, quoteBody(w))).status).toBe(404);

    // while waiting: pending, not generated offers
    const pending = (await w.buyer.call("GET", `/orgs/${w.buyerOrg}/requests/${rid}`)).body;
    expect(pending.recipients[0].status).toBe("pending response");
    expect(pending.quotesReceived).toBe(0);

    const q = await submitQuote(w, rid);
    const cmp = (await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${rid}/comparisons`, {})).body;
    expect(cmp.generatedBy).toMatch(/Not an AI summary/);
    expect(cmp.lanes.verified_agent).toHaveLength(0);
    expect(cmp.lanes.manual[0]).toMatchObject({ rank: 1, landedTotal: "NGN 105,000.00", landedTotalMinor: "10500000", supplierName: "Palm Oil Traders" });
    expect(cmp.lanes.manual[0].verification).toMatch(/no agent verification applies/);

    const i = (await intent(w, rid, q.id)).body;
    expect(i.buttonLabel).toBe("Approve order for NGN 105,000.00");
    const c1 = await confirm(w, i);
    expect(c1.status).toBe(201);
    const replay = await confirm(w, i);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ orderId: c1.body.orderId, replay: true });
    expect(await prisma.order.count({ where: { requestId: rid } })).toBe(1);

    const orderId = c1.body.orderId;
    // supplier cannot confirm receipt, and cannot reach the buyer's org
    expect((await w.sup.call("POST", `/orgs/${w.buyerOrg}/orders/${orderId}/receipt`, { outcome: "full" })).status).toBe(404);
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/receipt`, { outcome: "full" })).status).toBe(403);
    // buyer cannot accept on the supplier's behalf
    expect((await w.buyer.call("POST", `/orgs/${w.buyerOrg}/orders/${orderId}/accept`, {})).status).toBe(403);

    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/accept`, {})).status).toBe(200);
    const stock = await prisma.inventoryStatement.findFirstOrThrow({ where: { productId: w.productId }, orderBy: { statedAt: "desc" } });
    expect(stock.reservedScaled).toBe(40_000_000n);
    // delivered cannot be skipped to
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/progress`, { to: "delivered" })).status).toBe(409);
    for (const to of ["preparing", "dispatched", "delivered"]) expect((await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/progress`, { to })).status).toBe(200);
    // supplier "delivered" is not completion
    expect((await w.buyer.call("GET", `/orgs/${w.buyerOrg}/orders/${orderId}`)).body.state).toBe("delivered_awaiting_buyer_confirmation");
    expect((await w.buyer.call("POST", `/orgs/${w.buyerOrg}/orders/${orderId}/receipt`, { outcome: "full" })).body.state).toBe("completed");
    expect((await prisma.procurementRequest.findUniqueOrThrow({ where: { id: rid } })).state).toBe("closed");

    const buyerExport = (await w.buyer.call("GET", `/orgs/${w.buyerOrg}/orders/${orderId}/export`)).body;
    expect(buyerExport.snapshot.calculationVersion).toBe("cmp-1");
    expect(buyerExport.approval.totalMinor).toBe("10500000");
    const supplierExport = (await w.sup.call("GET", `/orgs/${w.supOrg}/orders/${orderId}/export`)).body;
    expect(supplierExport.approval).toBeUndefined();
    expect(JSON.stringify(supplierExport)).not.toMatch(/budget/i);
    expect(buyerExport.limits.join(" ")).toMatch(/not immutable/);
    // supplier directory shows real completed history only after completion
    const dir = (await w.buyer.call("GET", "/suppliers?category=palm_oil")).body.suppliers as Json[];
    expect(dir.find((s) => s.orgId === w.supOrg).completedOrders).toBe(1);
  });

  it("approval of version A never authorises version B; superseded versions are not compared", async () => {
    const w = await world();
    const rid = await publishedRequest(w);
    const v1 = await submitQuote(w, rid);
    const i = (await intent(w, rid, v1.id)).body;
    const v2 = await submitQuote(w, rid, { unitPrice: "2400.00", goodsTotal: "96000.00" });
    expect(v2.version).toBe(2);
    const c = await confirm(w, i);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("APPROVAL_REJECTED");
    expect(c.body.error.details.reasons).toContain("QUOTE_VERSION_CHANGED");
    expect(await prisma.order.count({ where: { requestId: rid } })).toBe(0);
    const cmp = (await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${rid}/comparisons`, {})).body;
    expect(cmp.lanes.manual.map((o: Json) => o.quoteVersionId)).toEqual([v2.id]);
    expect((await intent(w, rid, v1.id)).status).toBe(422); // old version cannot be approved at all
  });

  it("simultaneous confirms and competing approvals create exactly one order", async () => {
    const w = await world();
    const rid = await publishedRequest(w);
    const q = await submitQuote(w, rid);
    const i = (await intent(w, rid, q.id)).body;
    const same = await Promise.all([confirm(w, i), confirm(w, i), confirm(w, i)]);
    expect(same.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(same.map((r) => r.body.orderId)).size).toBe(1);

    const rid2 = await publishedRequest(w);
    const q2 = await submitQuote(w, rid2);
    const [a, b] = await Promise.all([intent(w, rid2, q2.id), intent(w, rid2, q2.id)]);
    const results = await Promise.all([confirm(w, a.body), confirm(w, b.body)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await prisma.order.count({ where: { requestId: rid2 } })).toBe(1);
  });

  it("excludes incomplete, over-budget, manual-not-permitted and expired quotes, with reasons", async () => {
    const w = await world();
    const rid = await publishedRequest(w);
    const unknown = await submitQuote(w, rid, { charges: [{ kind: "delivery", label: "Delivery", amount: null, mandatory: true }, { kind: "tax", label: "VAT", amount: "0.00", mandatory: true }] });
    let cmp = (await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${rid}/comparisons`, {})).body;
    expect(cmp.noEligibleOffers).toBe(true);
    expect(cmp.nextSteps).toMatch(/revise the request/);
    expect(cmp.excluded[0].reasons.map((x: Json) => x.code)).toContain("INCOMPLETE_TOTAL");
    const refused = await intent(w, rid, unknown.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("NOT_ELIGIBLE");

    const over = await submitQuote(w, rid, { unitPrice: "3000.00", goodsTotal: "120000.00" }); // 120,000 + 5,000 delivery > budget
    cmp = (await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${rid}/comparisons`, {})).body;
    expect(cmp.excluded.find((e: Json) => e.quoteVersionId === over.id).reasons.map((x: Json) => x.code)).toContain("OVER_BUDGET");

    const ridStrict = await publishedRequest(w, { allowManualLane: false });
    await submitQuote(w, ridStrict);
    cmp = (await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${ridStrict}/comparisons`, {})).body;
    expect(cmp.excluded[0].reasons.map((x: Json) => x.code)).toContain("MANUAL_LANE_NOT_PERMITTED");

    const ridExp = await publishedRequest(w);
    const short = await w.sup.call("POST", `/orgs/${w.supOrg}/requests/${ridExp}/quotes`, quoteBody(w, { validUntil: iso(1200) }));
    expect(short.status).toBe(201);
    await new Promise((r) => setTimeout(r, 1500));
    const exp = await intent(w, ridExp, short.body.id);
    expect(exp.status).toBe(422);
    expect(JSON.stringify(exp.body.error.details)).toMatch(/expired/i);
  });

  it("agent-sourced quotes are refused until agent verification exists", async () => {
    const w = await world();
    const rid = await publishedRequest(w);
    const r = await w.sup.call("POST", `/orgs/${w.supOrg}/requests/${rid}/quotes`, quoteBody(w, { source: "supplier_agent" }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("AGENT_QUOTING_NOT_AVAILABLE");
  });

  it("stock: reservation happens on acceptance and cannot oversell, even simultaneously", async () => {
    const w = await world();
    const a = await toOrder(w, "70", "175000.00");
    const b = await toOrder(w, "70", "175000.00");
    const results = await Promise.all([
      w.sup.call("POST", `/orgs/${w.supOrg}/orders/${a.orderId}/accept`, {}),
      w.sup.call("POST", `/orgs/${w.supOrg}/orders/${b.orderId}/accept`, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("STOCK_CONFLICT");
    const st = await prisma.inventoryStatement.findFirstOrThrow({ where: { productId: w.productId }, orderBy: { statedAt: "desc" } });
    expect(st.reservedScaled).toBe(70_000_000n);
    const loser = results[0]!.status === 409 ? a.orderId : b.orderId;
    expect((await prisma.order.findUniqueOrThrow({ where: { id: loser } })).state).toBe("awaiting_supplier_acceptance"); // rolled back
    // the database itself refuses to oversell
    await expect(prisma.$executeRaw`UPDATE "InventoryStatement" SET "reservedScaled" = "availableScaled" + 1 WHERE id = ${st.id}`).rejects.toThrow();
    // stock cannot be restated below what is reserved
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/products/${w.productId}/inventory`, { available: "50" })).body.error.code).toBe("BELOW_RESERVED");
  });

  it("partial receipt keeps both parties' conflicting reports; buyer closes without AI or auto-resolution", async () => {
    const w = await world();
    const { orderId } = await toOrder(w);
    for (const step of ["accept"]) await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/${step}`, {});
    for (const to of ["preparing", "dispatched", "delivered"]) await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/progress`, { to });
    expect((await w.buyer.call("POST", `/orgs/${w.buyerOrg}/orders/${orderId}/receipt`, { outcome: "partial" })).status).toBe(400); // quantity required
    expect((await w.buyer.call("POST", `/orgs/${w.buyerOrg}/orders/${orderId}/receipt`, { outcome: "partial", receivedQuantity: "30", note: "Only 30 L arrived" })).body.state).toBe("partially_fulfilled");
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/discrepancy-response`, { note: "We delivered 40 L; driver's log attached", quantity: "40" })).status).toBe(200);
    const d = await prisma.discrepancy.findFirstOrThrow({ where: { update: { orderId } } });
    expect(d.buyerReport).toMatchObject({ receivedScaled: "30000000", note: "Only 30 L arrived" });
    expect(d.supplierReport).toMatchObject({ quantity: "40" });
    expect((await w.buyer.call("POST", `/orgs/${w.buyerOrg}/orders/${orderId}/discrepancy-resolution`, { note: "Agreed to credit 10 L" })).body.state).toBe("completed");
    const after = await prisma.discrepancy.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.buyerReport).toEqual(d.buyerReport); // never overwritten
    expect(after.supplierReport).toEqual(d.supplierReport);
    expect(after.status).toBe("closed_by_buyer");
  });

  it("decline returns the request to the buyer, who may approve again", async () => {
    const w = await world();
    const { rid, q, orderId } = await toOrder(w);
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${orderId}/decline`, { reason: "Out of stock this week" })).body.state).toBe("declined");
    expect((await prisma.procurementRequest.findUniqueOrThrow({ where: { id: rid } })).state).toBe("ready_for_comparison");
    const again = await confirm(w, (await intent(w, rid, q.id)).body);
    expect(again.status).toBe(201);
    expect(again.body.orderId).not.toBe(orderId);
    // after acceptance the buyer cannot silently cancel
    await w.sup.call("POST", `/orgs/${w.supOrg}/orders/${again.body.orderId}/accept`, {});
    expect((await w.buyer.call("POST", `/orgs/${w.buyerOrg}/orders/${again.body.orderId}/cancel`, {})).body.error.code).toBe("CHANGE_REQUEST_REQUIRED");
  });

  it("roles: staff may draft but not submit; requesters cannot approve; auditors read activity only", async () => {
    const w = await world();
    const staff = await addMember(w.sup, w.supOrg, "supplier_staff", "staff");
    const requester = await addMember(w.buyer, w.buyerOrg, "buyer_requester", "requester");
    const auditor = await addMember(w.buyer, w.buyerOrg, "read_only_auditor", "auditor");
    const rid = await publishedRequest(w);
    const draft = await staff.call("POST", `/orgs/${w.supOrg}/requests/${rid}/quotes`, quoteBody(w, { submit: false }));
    expect(draft.status).toBe(201);
    expect(draft.body.submittedAt).toBeNull();
    expect((await staff.call("POST", `/orgs/${w.supOrg}/requests/${rid}/quotes`, quoteBody(w, { submit: true }))).status).toBe(403);
    expect((await staff.call("POST", `/orgs/${w.supOrg}/quotes/${draft.body.quoteId}/versions/${draft.body.id}/submit`, {})).status).toBe(403);
    // drafts are invisible to the buyer until a manager submits them
    expect((await w.buyer.call("GET", `/orgs/${w.buyerOrg}/requests/${rid}`)).body.quotesReceived).toBe(0);
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/quotes/${draft.body.quoteId}/versions/${draft.body.id}/submit`, {})).status).toBe(200);
    // a submitted version is frozen, including against direct database edits
    await expect(prisma.quoteVersion.update({ where: { id: draft.body.id }, data: { goodsTotalMinor: 1n } })).rejects.toThrow(/immutable/);
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/quotes/${draft.body.quoteId}/versions/${draft.body.id}/submit`, {})).status).toBe(409);

    expect((await requester.call("POST", `/orgs/${w.buyerOrg}/requests/${rid}/approval-intents`, { quoteVersionId: draft.body.id })).status).toBe(403);
    expect((await auditor.call("GET", `/orgs/${w.buyerOrg}/activity`)).status).toBe(200);
    expect((await auditor.call("POST", `/orgs/${w.buyerOrg}/requests`, requestBody())).status).toBe(403);
    expect((await requester.call("GET", `/orgs/${w.buyerOrg}/activity`)).status).toBe(403);
  });

  it("cross-tenant: other organisations cannot read requests, orders or competing quotes", async () => {
    const w = await world();
    const { rid, orderId } = await toOrder(w);
    const stranger = await user("stranger");
    const strangerOrg = await org(stranger, "Stranger Foods", "buyer");
    expect((await stranger.call("GET", `/orgs/${strangerOrg}/requests/${rid}`)).status).toBe(404);
    expect((await stranger.call("GET", `/orgs/${strangerOrg}/orders/${orderId}`)).status).toBe(404);
    expect((await stranger.call("GET", `/orgs/${w.buyerOrg}/orders/${orderId}`)).status).toBe(404);
    expect((await w.other.call("GET", `/orgs/${w.otherOrg}/orders/${orderId}`)).status).toBe(404);
    expect((await w.other.call("GET", `/orgs/${w.otherOrg}/requests/${rid}/quotes`)).body.quote).toBeNull(); // only own quote is ever returned
    expect((await stranger.call("GET", `/orgs/${strangerOrg}/orders/${orderId}/export`)).status).toBe(404);
    // an organisation id from the URL does not grant anything: buyer-only org cannot use supplier endpoints
    expect((await w.buyer.call("GET", `/orgs/${w.buyerOrg}/inbox`)).status).toBe(403);
    expect((await w.sup.call("POST", `/orgs/${w.supOrg}/requests`, requestBody())).status).toBe(403);
  });

  it("published requests are fixed; drafts are editable and validated without losing input", async () => {
    const w = await world();
    const created = (await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests`, requestBody())).body;
    const bad = await w.buyer.call("PUT", `/orgs/${w.buyerOrg}/requests/${created.id}`, requestBody({ quantity: "0", deliverTz: "Mars/Olympus" }));
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details).length).toBeGreaterThan(0);
    expect((await w.buyer.call("PUT", `/orgs/${w.buyerOrg}/requests/${created.id}`, requestBody({ quantity: "45" }))).body.version).toBe(2);
    const pub = await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${created.id}/publish`, { supplierOrgIds: [w.supOrg], responseDeadline: iso(DAY), confirmShare: false });
    expect(pub.status).toBe(400); // must explicitly confirm sharing
    await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${created.id}/publish`, { supplierOrgIds: [w.supOrg], responseDeadline: iso(DAY), confirmShare: true });
    expect((await w.buyer.call("PUT", `/orgs/${w.buyerOrg}/requests/${created.id}`, requestBody())).status).toBe(409);
    // cannot invite yourself or a non-supplier
    const second = (await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests`, requestBody())).body;
    expect((await w.buyer.call("POST", `/orgs/${w.buyerOrg}/requests/${second.id}/publish`, { supplierOrgIds: [w.buyerOrg], responseDeadline: iso(DAY), confirmShare: true })).body.error.code).toBe("INVALID_RECIPIENTS");
  });
});
