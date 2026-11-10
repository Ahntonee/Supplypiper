import { generateKeyPairSync } from "node:crypto";
import { AccountAddress, buildBasicAccountSigner, signMessage, type AccountInfo } from "@concordium/web-sdk";
import { describe, expect, it } from "vitest";
import { buildChallenge, CHALLENGE_TTL_MS, hashNonce, verifyOwnership, type AccountInfoProvider } from "./index";
import fx from "../fixtures/agent_of.testnet.json";

const ACCOUNT = fx.valid!.owner_account as string; // a real testnet account address (format only; keys below are local)
const TOKEN = "JyP9UhTu6PeHXpm6LAhSy";
const NOW = new Date("2026-11-10T12:00:00Z");
const ctx = { orgId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", tokenAddress: TOKEN, network: "testnet" as const, audience: "supplypiper.example" };

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    priv: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32).toString("hex"),
    pub: (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex"),
  };
}
const infoFor = (pub: string): AccountInfo => ({
  accountAddress: AccountAddress.fromBase58(ACCOUNT), accountThreshold: 1,
  accountCredentials: { 0: { v: 0, value: { contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey: pub } } } } } } },
} as unknown as AccountInfo);
const providerFor = (pub: string | null): AccountInfoProvider => ({ async getAccountInfo() { return pub ? infoFor(pub) : null; } });
const sign = (priv: string, message: string) => signMessage(AccountAddress.fromBase58(ACCOUNT), message, buildBasicAccountSigner(priv));

describe("ownership challenge", () => {
  it("binds network, agent, organisation, user, audience, nonce and expiry; carries no personal data", () => {
    const c = buildChallenge(ctx, NOW, "NONCE123");
    for (const part of ["Network: testnet", `Agent token: ${TOKEN}`, `Organisation: ${ctx.orgId}`, `User: ${ctx.userId}`, "Audience: supplypiper.example", "Nonce: NONCE123"]) expect(c.message).toContain(part);
    expect(c.expiresAt.getTime() - NOW.getTime()).toBe(CHALLENGE_TTL_MS);
    expect(c.message).toContain(`Expires: ${c.expiresAt.toISOString()}`);
    expect(c.message).not.toMatch(/@|password|seed|private/i);
  });
  it("issues a fresh random nonce each time and stores only its hash", () => {
    const a = buildChallenge(ctx, NOW), b = buildChallenge(ctx, NOW);
    expect(a.nonce).not.toBe(b.nonce);
    expect(hashNonce(a.nonce)).not.toContain(a.nonce);
    expect(hashNonce(a.nonce)).toBe(hashNonce(a.nonce));
  });
});

describe("verifyOwnership (real SDK signing, local test key)", () => {
  const k = keypair();
  const c = buildChallenge(ctx, NOW, "N1");
  const base = { storedMessage: c.message, submittedMessage: c.message, expiresAt: c.expiresAt, now: NOW, network: "testnet" as const, account: ACCOUNT };

  it("accepts a signature from a key the account currently has on-chain", async () => {
    expect(await verifyOwnership({ ...base, signature: await sign(k.priv, c.message), provider: providerFor(k.pub) })).toEqual({ ok: true });
  });
  it("rejects a signature from any other key", async () => {
    const other = keypair();
    expect(await verifyOwnership({ ...base, signature: await sign(other.priv, c.message), provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("rotated key: the old key stops working as soon as the chain shows a new one", async () => {
    const sig = await sign(k.priv, c.message);
    const rotated = keypair();
    expect(await verifyOwnership({ ...base, signature: sig, provider: providerFor(rotated.pub) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("a signature over a different message (another nonce, org or agent) does not verify", async () => {
    const c2 = buildChallenge(ctx, NOW, "N2");
    expect(await verifyOwnership({ ...base, signature: await sign(k.priv, c2.message), provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    const forOtherAgent = buildChallenge({ ...ctx, tokenAddress: "JyP9U6SVHZgayqA5XfHfA" }, NOW, "N1");
    expect(await verifyOwnership({ ...base, signature: await sign(k.priv, forOtherAgent.message), provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("the server's stored message wins over whatever the client submits", async () => {
    const tampered = c.message.replace("Network: testnet", "Network: mainnet");
    expect(await verifyOwnership({ ...base, submittedMessage: tampered, signature: await sign(k.priv, tampered), provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "MESSAGE_MISMATCH" });
  });
  it("expired challenges are refused, including exactly at expiry", async () => {
    const sig = await sign(k.priv, c.message);
    expect(await verifyOwnership({ ...base, now: c.expiresAt, signature: sig, provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "EXPIRED" });
    expect(await verifyOwnership({ ...base, now: new Date(c.expiresAt.getTime() - 1), signature: sig, provider: providerFor(k.pub) })).toEqual({ ok: true });
  });
  it("unknown account, chain outage and junk account strings are distinct, safe failures", async () => {
    const sig = await sign(k.priv, c.message);
    expect(await verifyOwnership({ ...base, signature: sig, provider: providerFor(null) })).toEqual({ ok: false, reason: "ACCOUNT_NOT_FOUND" });
    expect(await verifyOwnership({ ...base, signature: sig, provider: { async getAccountInfo() { throw new Error("grpc down"); } } })).toEqual({ ok: false, reason: "CHAIN_UNAVAILABLE" });
    expect(await verifyOwnership({ ...base, account: "not-an-account", signature: sig, provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "BAD_ACCOUNT" });
  });
  it("malformed signature objects fail closed", async () => {
    expect(await verifyOwnership({ ...base, signature: { 0: { 0: "zz" } }, provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(await verifyOwnership({ ...base, signature: {} as never, provider: providerFor(k.pub) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
});
