import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { AccountAddress, buildBasicAccountSigner, signMessage, type AccountInfo } from "@concordium/web-sdk";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeAccountAddress, encodeTokenAddress, NOT_ESTABLISHED_ALWAYS, type AccountInfoProvider, type AgentVerifier, type VerificationResult, type VerifyInput,
} from "@supplypiper/concordium";
import { createVerificationService } from "../../apps/api/src/agentVerification";
import { createApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://supplypiper:devonly@127.0.0.1:54329/supplypiper_test";
const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
let dbUp = false;
try { await prisma.$queryRaw`SELECT 1`; dbUp = true; } catch { /* reported as SKIPPED */ }
if (!dbUp) console.warn("SKIPPED: agent integration tests need PostgreSQL at TEST_DATABASE_URL (run `npm run db:dev`).");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Test double for the registry check: the product code under test is everything AROUND it (gating, freshness, authority, persistence). */
class ControlledVerifier implements AgentVerifier {
  outcome = new Map<string, VerificationResult["status"]>(); calls: string[] = [];
  async verify(i: VerifyInput): Promise<VerificationResult> {
    this.calls.push(i.tokenAddress);
    const status = this.outcome.get(i.tokenAddress) ?? "verified";
    return {
      status, network: i.network, checkedAt: new Date(), reasons: [status === "verified" ? "CHECK_OK" : status === "unavailable" ? "UPSTREAM_UNREACHABLE" : status === "revoked" ? "AGENT_REVOKED" : "OWNER_MISMATCH"],
      simulated: false, established: status === "verified" ? ["test double: all checks passed"] : [], notEstablished: NOT_ESTABLISHED_ALWAYS,
      chainRef: { registry: "12802,0", tokenAddress: i.tokenAddress, ownerAccount: i.expectedOwnerAccount ?? undefined, evidenceUrl: `https://registry.test/badge-check/${i.tokenAddress}` },
    };
  }
}

describe.skipIf(!dbUp)("agent accountability: registration, ownership proof, authority and gating (real PostgreSQL)", () => {
  const verifier = new ControlledVerifier();
  const keys = new Map<string, string>(); // account -> public key hex (stands in for on-chain keys)
  let chainDown = false;
  const accountProvider: AccountInfoProvider = {
    async getAccountInfo(_n, account): Promise<AccountInfo | null> {
      if (chainDown) throw new Error("node unreachable");
      const pub = keys.get(account); if (!pub) return null;
      return { accountAddress: AccountAddress.fromBase58(account), accountThreshold: 1, accountCredentials: { 0: { v: 0, value: { contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey: pub } } } } } } } } as unknown as AccountInfo;
    },
  };

  let base = ""; let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  beforeAll(() => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe", shell: true });
    const config = loadConfig({ SUPPLYPIPER_MODE: "demo", VERIFICATION_ADAPTER: "mock", DATABASE_URL: DB_URL });
    const verification = createVerificationService({ prisma, verifier, freshnessMs: config.verificationFreshnessMs, sourceLabel: "test-double" });
    server = createApp({ config, prisma, checkReady: async () => true, verification, accountProvider, audience: "test.supplypiper" }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => { server?.close(); await prisma.$disconnect(); });

  class Client {
    cookie = ""; csrf = ""; email = ""; userId = "";
    async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { "x-csrf-token": this.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get("set-cookie");
      if (set?.startsWith("sp_session=") && !set.includes("sp_session=;")) this.cookie = set.split(";")[0]!;
      const t = await res.text();
      return { status: res.status, body: t ? JSON.parse(t) : null };
    }
  }
  const PW = "correct-horse-battery";
  async function mailToken(to: string, template: string) {
    const ev = await prisma.outboxEvent.findFirst({ where: { topic: "email", payload: { path: ["to"], equals: to } }, orderBy: { createdAt: "desc" } });
    const p = ev?.payload as { template: string; data: { token: string } };
    expect(p.template).toBe(template); return p.data.token;
  }
  async function user(label: string) {
    const c = new Client(); c.email = `${label}-${randomUUID()}@example.test`;
    await c.call("POST", "/auth/register", { email: c.email, password: PW, displayName: label });
    await c.call("POST", "/auth/verify-email", { token: await mailToken(c.email, "verify_email") });
    const l = await c.call("POST", "/auth/login", { email: c.email, password: PW });
    c.csrf = l.body.csrfToken; c.userId = l.body.user.id; return c;
  }
  const org = async (c: Client, name: string, cap: "buyer" | "supplier") => (await c.call("POST", "/orgs", { name, capabilities: [cap] })).body.id as string;
  async function addMember(owner: Client, orgId: string, role: string, label: string) {
    const m = await user(label);
    await owner.call("POST", `/orgs/${orgId}/invitations`, { email: m.email, role });
    expect((await m.call("POST", "/invitations/accept", { token: await mailToken(m.email, "org_invitation") })).status).toBe(200);
    return m;
  }

  const freshToken = () => encodeTokenAddress({ contractIndex: 12802n, contractSubindex: 0n, tokenId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)) });
  const mintAccount = () => { const a = encodeAccountAddress(randomBytes(32)); const kp = generateKeyPairSync("ed25519"); const priv = (kp.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32).toString("hex"); const pub = (kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex"); keys.set(a, pub); return { account: a, priv }; };
  const signWith = (account: string, priv: string, message: string) => signMessage(AccountAddress.fromBase58(account), message, buildBasicAccountSigner(priv));

  async function supplierWorld() {
    const owner = await user("owner"); const supOrg = await org(owner, `Agent Co ${randomUUID().slice(0, 6)}`, "supplier");
    await owner.call("PUT", `/orgs/${supOrg}/supplier-profile`, { category: "palm_oil", areaCode: "lagos-mainland" });
    return { owner, supOrg };
  }
  async function registerAgent(w: Awaited<ReturnType<typeof supplierWorld>>, operatorType = "supplier_owned") {
    const token = freshToken();
    const r = await w.owner.call("POST", `/orgs/${w.supOrg}/agents`, { network: "testnet", tokenAddress: token, operatorType });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { token, id: r.body.id as string };
  }
  async function proveOwner(w: Awaited<ReturnType<typeof supplierWorld>>, agentId: string, who = mintAccount(), by: Client = w.owner) {
    const ch = (await by.call("POST", `/orgs/${w.supOrg}/agents/${agentId}/challenge`, {})).body;
    const sig = await signWith(who.account, who.priv, ch.message);
    const r = await by.call("POST", `/orgs/${w.supOrg}/agents/${agentId}/ownership`, { challengeId: ch.challengeId, account: who.account, message: ch.message, signature: sig });
    return { r, ch, who };
  }

  it("registers agents only on the trusted registry for this environment, once, and only for permitted roles", async () => {
    const w = await supplierWorld();
    const staff = await addMember(w.owner, w.supOrg, "supplier_staff", "staff");
    const manager = await addMember(w.owner, w.supOrg, "supplier_manager", "mgr");
    const token = freshToken();
    expect((await staff.call("POST", `/orgs/${w.supOrg}/agents`, { network: "testnet", tokenAddress: token, operatorType: "supplier_owned" })).status).toBe(403);
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents`, { network: "mainnet", tokenAddress: token, operatorType: "supplier_owned" })).body.error.code).toBe("NETWORK_NOT_ALLOWED"); // demo/testnet environments use testnet only
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents`, { network: "testnet", tokenAddress: "Mf22oVneFJJsAWi8saupU", operatorType: "supplier_owned" })).body.error.code).toBe("UNTRUSTED_REGISTRY"); // a real mainnet token
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents`, { network: "testnet", tokenAddress: "JyP9UhTu6PeHXpm6LAhSz", operatorType: "supplier_owned" })).status).toBe(400); // bad checksum
    const ok = await manager.call("POST", `/orgs/${w.supOrg}/agents`, { network: "testnet", tokenAddress: token, operatorType: "platform_operated" });
    expect(ok.status).toBe(201);
    expect(ok.body.operatorNote).toMatch(/not independent supplier ownership/);
    expect(ok.body).toMatchObject({ ownerAccount: null, authority: { bound: false } }); // nothing is trusted yet
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents`, { network: "testnet", tokenAddress: token, operatorType: "supplier_owned" })).body.error.code).toBe("AGENT_ALREADY_REGISTERED");
    expect((await staff.call("GET", `/orgs/${w.supOrg}/agents`)).body.agents).toHaveLength(1); // staff may view
  });

  it("a pasted address proves nothing: ownership needs a fresh, single-use wallet signature bound to this user, org and agent", async () => {
    const w = await supplierWorld(); const a = await registerAgent(w);
    const { r, ch, who } = await proveOwner(w, a.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ownerAccount: who.account, authority: { bound: false } }); // proof of ownership is not authority
    expect(ch.message).toContain(a.token);
    expect(ch.message).toContain(w.supOrg);
    // replaying the same challenge and signature fails
    const sig = await signWith(who.account, who.priv, ch.message);
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/ownership`, { challengeId: ch.challengeId, account: who.account, message: ch.message, signature: sig })).body.error.code).toBe("CHALLENGE_INVALID");
    expect(await prisma.auditEvent.count({ where: { objectId: a.id, event: "agent.owner_proved" } })).toBe(1);
  });

  it("refuses wrong keys, tampered messages, expired challenges and other users' challenges, without binding anything", async () => {
    const w = await supplierWorld(); const a = await registerAgent(w);
    const who = mintAccount(); const impostor = mintAccount();
    const mk = async (by: Client = w.owner) => (await by.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/challenge`, {})).body;
    const send = (ch: Json, body: Json, by: Client = w.owner) => by.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/ownership`, { challengeId: ch.challengeId, ...body });

    let ch = await mk();
    const wrongKey = await send(ch, { account: who.account, message: ch.message, signature: await signWith(who.account, impostor.priv, ch.message) });
    expect(wrongKey.status).toBe(400); expect(wrongKey.body.error.details.reason).toBe("BAD_SIGNATURE");
    const tampered = ch.message.replace("Network: testnet", "Network: mainnet");
    expect((await send(ch, { account: who.account, message: tampered, signature: await signWith(who.account, who.priv, tampered) })).body.error.details.reason).toBe("MESSAGE_MISMATCH");
    expect((await send(ch, { account: encodeAccountAddress(randomBytes(32)), message: ch.message, signature: await signWith(who.account, who.priv, ch.message) })).body.error.details.reason).toBe("ACCOUNT_NOT_FOUND");
    chainDown = true;
    const down = await send(ch, { account: who.account, message: ch.message, signature: await signWith(who.account, who.priv, ch.message) });
    chainDown = false;
    expect(down.status).toBe(503); expect(down.body.error.code).toBe("CHAIN_UNAVAILABLE");
    // the failed attempts did not consume the challenge, and bound nothing
    expect((await prisma.agentRegistration.findUniqueOrThrow({ where: { id: a.id } })).ownerAccount).toBeNull();
    expect((await send(ch, { account: who.account, message: ch.message, signature: await signWith(who.account, who.priv, ch.message) })).status).toBe(200);

    const a2 = await registerAgent(w);
    const other = await addMember(w.owner, w.supOrg, "supplier_manager", "mgr2");
    const ch2 = (await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a2.id}/challenge`, {})).body;
    const stolen = await other.call("POST", `/orgs/${w.supOrg}/agents/${a2.id}/ownership`, { challengeId: ch2.challengeId, account: who.account, message: ch2.message, signature: await signWith(who.account, who.priv, ch2.message) });
    expect(stolen.body.error.code).toBe("CHALLENGE_INVALID"); // issued to a different user
    const ch3 = (await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a2.id}/challenge`, {})).body;
    await prisma.ownershipChallenge.update({ where: { id: ch3.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a2.id}/ownership`, { challengeId: ch3.challengeId, account: who.account, message: ch3.message, signature: await signWith(who.account, who.priv, ch3.message) })).body.error.details.reason).toBe("EXPIRED");
  });

  it("authority is a separate organisation action, owner-only, needs a proven owner, and dies when the owner changes", async () => {
    const w = await supplierWorld(); const a = await registerAgent(w);
    const manager = await addMember(w.owner, w.supOrg, "supplier_manager", "mgr");
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/authorise`, { confirm: true })).body.error.code).toBe("OWNER_NOT_PROVEN");
    const first = await proveOwner(w, a.id);
    expect((await manager.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/authorise`, { confirm: true })).status).toBe(403); // managers can run the agent, not grant it authority
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/authorise`, {})).status).toBe(400); // explicit confirmation required
    const granted = await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/authorise`, { confirm: true });
    expect(granted.body.authority).toMatchObject({ bound: true, voidBecauseOwnerChanged: false });
    // re-proving the SAME owner keeps authority; a different owner (transfer or key change) voids it
    expect((await proveOwner(w, a.id, first.who)).r.body.authority.bound).toBe(true);
    const next = await proveOwner(w, a.id, mintAccount());
    expect(next.r.body.ownerAccount).not.toBe(first.who.account);
    expect(next.r.body.authority).toMatchObject({ bound: false });
    expect(await prisma.auditEvent.count({ where: { objectId: a.id, event: "agent.owner_changed_authority_cleared" } })).toBe(1);
    // the database itself refuses authority without a proven owner
    await expect(prisma.$executeRaw`UPDATE "AgentRegistration" SET "ownerAccount" = NULL, "ownerProvedAt" = NULL, "orgAuthorityBoundAt" = NOW() WHERE id = ${a.id}`).rejects.toThrow();
    // withdrawing is owner-only too
    await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/authorise`, { confirm: true });
    expect((await manager.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/withdraw-authority`, {})).status).toBe(403);
    expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/withdraw-authority`, {})).body.authority.bound).toBe(false);
  });

  it("check-now records every result, flags freshness, never reuses an outage as an answer, and is tenant-scoped", async () => {
    const w = await supplierWorld(); const a = await registerAgent(w); await proveOwner(w, a.id);
    const stranger = await user("stranger"); const sOrg = await org(stranger, "Other Supplier", "supplier");
    expect((await stranger.call("POST", `/orgs/${sOrg}/agents/${a.id}/check`, {})).status).toBe(404);
    expect((await stranger.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/check`, {})).status).toBe(404);
    const ok = (await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/check`, {})).body;
    expect(ok.latestCheck).toMatchObject({ status: "verified", network: "testnet", freshForOrders: true, simulated: false });
    expect(ok.latestCheck.evidenceUrl).toContain(a.token);
    expect(ok.latestCheck.notEstablished).toContain("Endorsement by Concordium");
    verifier.outcome.set(a.token, "unavailable");
    await new Promise((r) => setTimeout(r, 5200)); // past the 5 s repeat-click window
    const down = (await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/check`, {})).body;
    expect(down.latestCheck).toMatchObject({ status: "unavailable", freshForOrders: false });
    // the failed recheck is shown, but the last SUCCESSFUL check stays the earlier one and is never overwritten by it
    expect(down.lastSuccessfulCheckAt).toBe(ok.latestCheck.checkedAt);
    expect(new Date(down.latestCheck.checkedAt).getTime()).toBeGreaterThan(new Date(down.lastSuccessfulCheckAt).getTime());
    expect(await prisma.verificationAttempt.count({ where: { agentId: a.id } })).toBe(2);
    verifier.outcome.delete(a.token);
  }, 30_000);

  // --- gating in the buyer's decision. Agent quotes cannot yet be CREATED through the product (no quoting agent exists), so these
  // tests insert them directly to exercise the comparison and approval rules against the real database.
  const DAY = 864e5; const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  async function buyerAndRequest(supOrg: string) {
    const buyer = await user("buyer"); const buyerOrg = await org(buyer, "Mama Put Kitchen", "buyer");
    const rq = await buyer.call("POST", `/orgs/${buyerOrg}/requests`, { category: "palm_oil", quantity: "40", unit: "L", budget: "120000.00", currency: "NGN", deliverBy: iso(3 * DAY), deliverTz: "Africa/Lagos", destinationArea: "lagos-mainland", destinationAddress: "12 Allen Avenue, Ikeja", allowManualLane: true });
    expect((await buyer.call("POST", `/orgs/${buyerOrg}/requests/${rq.body.id}/publish`, { supplierOrgIds: [supOrg], responseDeadline: iso(DAY), confirmShare: true })).status).toBe(200);
    return { buyer, buyerOrg, requestId: rq.body.id as string };
  }
  async function agentQuote(requestId: string, supOrg: string, authorId: string, agentId: string | null, goods = 10_000_000n) {
    const q = await prisma.quote.create({ data: { requestId, supplierOrgId: supOrg, state: "submitted" } });
    const qv = await prisma.quoteVersion.create({ data: {
      quoteId: q.id, version: 1, source: "supplier_agent", authorUserId: authorId, agentId, currency: "NGN", category: "palm_oil", priceUnit: "L", deliversToArea: true,
      offeredScaled: 40_000_000n, offeredUnit: "L", unitPriceMinor: goods / 40n, goodsTotalMinor: goods,
      charges: [{ kind: "delivery", label: "Delivery", amountMinor: "500000", mandatory: true }, { kind: "tax", label: "VAT", amountMinor: "0", mandatory: true }],
      validUntil: new Date(Date.now() + 2 * DAY), deliveryPromisedBy: new Date(Date.now() + 2 * DAY), deliveryTz: "Africa/Lagos", paymentTerms: "On delivery", submittedAt: new Date() } });
    await prisma.procurementRequest.update({ where: { id: requestId }, data: { state: "collecting" } });
    return qv;
  }
  async function readyAgent(w: Awaited<ReturnType<typeof supplierWorld>>, authorise = true) {
    const a = await registerAgent(w); await proveOwner(w, a.id);
    if (authorise) expect((await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/authorise`, { confirm: true })).status).toBe(200);
    return a;
  }
  const compare = async (b: { buyer: Client; buyerOrg: string; requestId: string }) => (await b.buyer.call("POST", `/orgs/${b.buyerOrg}/requests/${b.requestId}/comparisons`, {})).body;

  it("verified agent + organisation authority puts a quote in the verified lane, with its evidence and limits shown", async () => {
    const w = await supplierWorld(); const a = await readyAgent(w, true); const b = await buyerAndRequest(w.supOrg);
    const qv = await agentQuote(b.requestId, w.supOrg, w.owner.userId, a.id);
    const cmp = await compare(b);
    expect(cmp.lanes.verified_agent.map((o: Json) => o.quoteVersionId)).toEqual([qv.id]);
    const ev = cmp.lanes.verified_agent[0].agentEvidence;
    expect(ev.identity).toMatchObject({ status: "verified", network: "testnet", freshForOrders: true, simulated: false });
    expect(ev.organisationAuthority).toBe("authorised by the supplier organisation");
    expect(ev.identity.notEstablished).toEqual(expect.arrayContaining(["Product quality", "Business registration", "Solvency"]));
    expect(ev.tokenAddress).toBe(a.token);
    expect(new Date(ev.lastSuccessfulCheckAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("each failure mode keeps the quote out of the verified lane, with its own reason", async () => {
    const w = await supplierWorld();
    const cases: Array<[string, (a: { token: string; id: string }) => Promise<void> | void, string]> = [
      ["revoked", (a) => { verifier.outcome.set(a.token, "revoked"); }, "VERIFICATION_NOT_VERIFIED"],
      ["owner changed on chain", (a) => { verifier.outcome.set(a.token, "invalid"); }, "VERIFICATION_NOT_VERIFIED"],
      ["registry unavailable", (a) => { verifier.outcome.set(a.token, "unavailable"); }, "VERIFICATION_NOT_VERIFIED"],
    ];
    for (const [label, arrange, reason] of cases) {
      const a = await readyAgent(w, true); const b = await buyerAndRequest(w.supOrg);
      await agentQuote(b.requestId, w.supOrg, w.owner.userId, a.id); await arrange(a);
      const cmp = await compare(b);
      expect(cmp.lanes.verified_agent, label).toHaveLength(0);
      expect(cmp.excluded[0].reasons.map((r: Json) => r.code), label).toContain(reason);
      expect(cmp.noEligibleOffers, label).toBe(true);
      verifier.outcome.delete(a.token);
    }
    // verified identity but the organisation never authorised the agent
    const a = await readyAgent(w, false); const b = await buyerAndRequest(w.supOrg);
    await agentQuote(b.requestId, w.supOrg, w.owner.userId, a.id);
    const cmp = await compare(b);
    expect(cmp.excluded[0].reasons.map((r: Json) => r.code)).toContain("AUTHORITY_NOT_BOUND");
    expect(cmp.excluded[0].agentEvidence.identity.status).toBe("verified"); // identity and authority are reported separately
    expect(cmp.excluded[0].agentEvidence.organisationAuthority).toBe("not authorised by the supplier organisation");
    // an agent registered to ANOTHER organisation cannot quote for this one
    const rival = await supplierWorld(); const foreign = await readyAgent(rival, true);
    const b2 = await buyerAndRequest(w.supOrg);
    await agentQuote(b2.requestId, w.supOrg, w.owner.userId, foreign.id);
    expect((await compare(b2)).excluded[0].reasons.map((r: Json) => r.code)).toEqual(expect.arrayContaining(["AUTHORITY_NOT_BOUND"]));
    // and a quote naming no registered agent never qualifies
    const b3 = await buyerAndRequest(w.supOrg);
    await agentQuote(b3.requestId, w.supOrg, w.owner.userId, null);
    expect((await compare(b3)).excluded[0].reasons.map((r: Json) => r.code)).toContain("VERIFICATION_MISSING");
  }, 60_000);

  it("a registry outage blocks only the verified lane; manual quotes and drafting keep working", async () => {
    const w = await supplierWorld(); const a = await readyAgent(w, true); const b = await buyerAndRequest(w.supOrg);
    await agentQuote(b.requestId, w.supOrg, w.owner.userId, a.id);
    verifier.outcome.set(a.token, "unavailable");
    // a human quote from a second supplier still compares and can be approved
    const other = await supplierWorld();
    await other.owner.call("PUT", `/orgs/${other.supOrg}/supplier-profile`, { category: "palm_oil", areaCode: "lagos-mainland" });
    const rec = await prisma.requestRecipient.create({ data: { requestId: b.requestId, supplierOrgId: other.supOrg } });
    void rec;
    const man = await other.owner.call("POST", `/orgs/${other.supOrg}/requests/${b.requestId}/quotes`, {
      category: "palm_oil", offeredQuantity: "40", offeredUnit: "L", unitPrice: "2500.00", priceUnit: "L", goodsTotal: "100000.00",
      charges: [{ kind: "delivery", label: "Delivery", amount: "5000.00", mandatory: true }, { kind: "tax", label: "VAT", amount: "0.00", mandatory: true }],
      validUntil: iso(2 * DAY), deliveryPromisedBy: iso(2 * DAY), deliveryTz: "Africa/Lagos", paymentTerms: "On delivery", deliversToArea: true, submit: true });
    expect(man.status, JSON.stringify(man.body)).toBe(201);
    const cmp = await compare(b);
    expect(cmp.lanes.verified_agent).toHaveLength(0);
    expect(cmp.lanes.manual).toHaveLength(1);
    const i = (await b.buyer.call("POST", `/orgs/${b.buyerOrg}/requests/${b.requestId}/approval-intents`, { quoteVersionId: man.body.id })).body;
    expect((await b.buyer.call("POST", `/orgs/${b.buyerOrg}/approvals/${i.intentId}/confirm`, { expectedTotalMinor: i.totalMinor })).status).toBe(201);
    verifier.outcome.delete(a.token);
  }, 30_000);

  it("approval re-checks identity at commit: a cached green result is never enough, and a fresh result is recorded on the order", async () => {
    const w = await supplierWorld(); const a = await readyAgent(w, true); const b = await buyerAndRequest(w.supOrg);
    const qv = await agentQuote(b.requestId, w.supOrg, w.owner.userId, a.id);
    expect((await compare(b)).lanes.verified_agent).toHaveLength(1); // green, and cached as a recent attempt
    const i = (await b.buyer.call("POST", `/orgs/${b.buyerOrg}/requests/${b.requestId}/approval-intents`, { quoteVersionId: qv.id })).body;
    const callsBefore = verifier.calls.length;

    verifier.outcome.set(a.token, "unavailable"); // the registry goes down between review and confirm
    const refused = await b.buyer.call("POST", `/orgs/${b.buyerOrg}/approvals/${i.intentId}/confirm`, { expectedTotalMinor: i.totalMinor });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reasons).toContain("VERIFICATION_NOT_FRESH");
    expect(verifier.calls.length).toBeGreaterThan(callsBefore); // it really asked again instead of trusting the earlier green
    expect(await prisma.order.count({ where: { requestId: b.requestId } })).toBe(0);

    verifier.outcome.set(a.token, "revoked"); // revoked meanwhile
    expect((await b.buyer.call("POST", `/orgs/${b.buyerOrg}/approvals/${i.intentId}/confirm`, { expectedTotalMinor: i.totalMinor })).body.error.details.reasons).toContain("VERIFICATION_NOT_FRESH");

    verifier.outcome.delete(a.token); // recovered: the same approval now succeeds, because the observation is fresh
    const ok = await b.buyer.call("POST", `/orgs/${b.buyerOrg}/approvals/${i.intentId}/confirm`, { expectedTotalMinor: i.totalMinor });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const order = await b.buyer.call("GET", `/orgs/${b.buyerOrg}/orders/${ok.body.orderId}`);
    expect(order.body.snapshot.verification).toMatch(/Agent identity verified on testnet at .*organisation authority recorded.*does not establish quality/);
    const snap = (await prisma.order.findUniqueOrThrow({ where: { id: ok.body.orderId } })).snapshot as Json;
    expect(snap.verificationEvidence).toMatchObject({ status: "verified", network: "testnet", simulated: false, organisationAuthorityBound: true });
  }, 30_000);

  it("authority withdrawn after the buyer reviewed the quote blocks the order", async () => {
    const w = await supplierWorld(); const a = await readyAgent(w, true); const b = await buyerAndRequest(w.supOrg);
    const qv = await agentQuote(b.requestId, w.supOrg, w.owner.userId, a.id);
    const i = (await b.buyer.call("POST", `/orgs/${b.buyerOrg}/requests/${b.requestId}/approval-intents`, { quoteVersionId: qv.id })).body;
    await w.owner.call("POST", `/orgs/${w.supOrg}/agents/${a.id}/withdraw-authority`, {});
    const r = await b.buyer.call("POST", `/orgs/${b.buyerOrg}/approvals/${i.intentId}/confirm`, { expectedTotalMinor: i.totalMinor });
    expect(r.status).toBe(409);
    expect(r.body.error.details.reasons).toContain("AUTHORITY_NOT_BOUND");
    expect(await prisma.order.count({ where: { requestId: b.requestId } })).toBe(0);
  }, 30_000);
});
