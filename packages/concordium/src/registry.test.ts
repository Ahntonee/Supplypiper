import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkBadge, createHardenedCardFetcher, createMcpClient, decodeTokenAddress, guardedLookup, isAccountAddress, RegistryVerifier, sha256Hex,
  TRUSTED_REGISTRIES, UpstreamError, type CardFetcher, type CardFetchResult, type RegistryClient,
} from "./index";
import fx from "../fixtures/agent_of.testnet.json";

// Real values recorded from the hosted registry on 2026-11-10 (see scripts/capture-fixtures.mjs).
const VALID_TOKEN = "JyP9UhTu6PeHXpm6LAhSy"; // testnet token id 43
const REVOKED_TOKEN = "JyP9U6SVHZgayqA5XfHfA"; // testnet token id 11
const BROKEN_CARD_TOKEN = "JyP9TtQC3HCNrTYR3sc2T"; // testnet token id 0 (card URL answers 404)
const MAINNET_TOKEN = "Mf22oVneFJJsAWi8saupU"; // mainnet token id 0
const validCard = new Uint8Array(readFileSync(new URL("../fixtures/valid-agent-card.testnet.json", import.meta.url)));
const NOW = new Date("2026-11-10T12:00:00Z");

const records: Record<string, unknown> = { "43": fx.valid, "11": fx.revoked, "0": fx.brokenCard };
const client = (over?: (tool: string, args: Record<string, unknown>) => { isError: boolean; value: unknown } | undefined): RegistryClient => ({
  async call(tool, args) {
    const o = over?.(tool, args); if (o) return o;
    return { isError: false, value: tool === "agent_of" ? (records[String(args.token_id)] ?? null) : null };
  },
});
const fetcher = (map: Record<string, CardFetchResult>): CardFetcher => ({ async fetch(url) { return map[url] ?? { kind: "failed", transient: false, status: 404, detail: "not found" }; } });
const okCard = (bytes: Uint8Array): CardFetchResult => ({ kind: "ok", status: 200, bytes });
const verifier = (c: RegistryClient, f: CardFetcher) => new RegistryVerifier({ client: c, cardFetcher: f, now: () => NOW });
const validFetcher = fetcher({ [fx.valid!.agent_uri as string]: okCard(validCard) });
const owner = fx.valid!.owner_account as string;

describe("token address decoding (checked against real registry addresses)", () => {
  it("decodes real testnet and mainnet badge strings", () => {
    expect(decodeTokenAddress(VALID_TOKEN)).toEqual({ contractIndex: 12802n, contractSubindex: 0n, tokenId: 43n });
    expect(decodeTokenAddress(REVOKED_TOKEN)).toEqual({ contractIndex: 12802n, contractSubindex: 0n, tokenId: 11n });
    expect(decodeTokenAddress(BROKEN_CARD_TOKEN)).toEqual({ contractIndex: 12802n, contractSubindex: 0n, tokenId: 0n });
    expect(decodeTokenAddress(MAINNET_TOKEN)).toEqual({ contractIndex: 10082n, contractSubindex: 0n, tokenId: 0n });
  });
  it("rejects bad checksums, junk and look-alikes", () => {
    expect(decodeTokenAddress("JyP9UhTu6PeHXpm6LAhSz")).toBeNull(); // one character changed
    expect(decodeTokenAddress("not-a-token")).toBeNull();
    expect(decodeTokenAddress("")).toBeNull();
    expect(decodeTokenAddress("<script src=x>")).toBeNull();
  });
  it("recognises real account addresses only", () => {
    expect(isAccountAddress(owner)).toBe(true);
    expect(isAccountAddress(VALID_TOKEN)).toBe(false);
    expect(isAccountAddress("3oPfuWN3BfDHa2GFstC9SkrSFkTWFKdrg2c9cLdpGjphewLJeA")).toBe(false);
  });
});

describe("RegistryVerifier outcomes on real recorded data", () => {
  it("verified: trusted registry, Active, bound owner, card hash matches the anchor, badge matches the chain", async () => {
    const r = await verifier(client(), validFetcher).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r.status).toBe("verified");
    expect(r.reasons).toEqual(["CHECK_OK"]);
    expect(r.network).toBe("testnet");
    expect(r.simulated).toBe(false);
    expect(r.checkedAt).toEqual(NOW);
    expect(r.chainRef).toMatchObject({ registry: "12802,0", tokenAddress: VALID_TOKEN, ownerAccount: owner, badgeEmbedding: "legacy" });
    expect(r.chainRef?.evidenceUrl).toBe(`https://agent-registry-mcp.concordium.com/v1/badge-check/${VALID_TOKEN}`);
    expect(r.established).toHaveLength(6);
    expect(r.notEstablished).toContain("Solvency");
  });

  it("owner changed since our proof: invalid, never verified", async () => {
    const r = await verifier(client(), validFetcher).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: fx.brokenCard!.owner_account as string });
    expect(fx.brokenCard!.owner_account).not.toBe(owner); // a genuinely different real account
    expect(r).toMatchObject({ status: "invalid", reasons: ["OWNER_MISMATCH"] });
  });

  it("no wallet proof on record: unverified", async () => {
    const r = await verifier(client(), validFetcher).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: null });
    expect(r).toMatchObject({ status: "unverified", reasons: ["OWNERSHIP_PROOF_MISSING"] });
  });

  it("revoked agent: revoked, with the on-chain reason surfaced", async () => {
    const r = await verifier(client(), validFetcher).verify({ network: "testnet", tokenAddress: REVOKED_TOKEN, expectedOwnerAccount: fx.revoked!.owner_account as string });
    expect(r).toMatchObject({ status: "revoked", reasons: ["AGENT_REVOKED"] });
    expect(r.chainRef?.revocationReason).toBeTruthy();
  });

  it("unknown agent: invalid", async () => {
    const r = await verifier(client(() => ({ isError: false, value: null })), validFetcher).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "invalid", reasons: ["AGENT_NOT_FOUND"] });
  });

  it("card host answers 404 (a real testnet agent): invalid, not verified, not 'unavailable'", async () => {
    const r = await verifier(client(), fetcher({})).verify({ network: "testnet", tokenAddress: BROKEN_CARD_TOKEN, expectedOwnerAccount: fx.brokenCard!.owner_account as string });
    expect(r).toMatchObject({ status: "invalid", reasons: ["CARD_UNREACHABLE"] });
  });

  it("card host down or slow: unavailable (retry later), never a stale green", async () => {
    const down = fetcher({ [fx.valid!.agent_uri as string]: { kind: "failed", transient: true, detail: "timed out" } });
    const r = await verifier(client(), down).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "unavailable", reasons: ["CARD_UNREACHABLE"] });
  });

  it("forged card (one byte differs): hash mismatch", async () => {
    const forged = new Uint8Array(validCard); forged[forged.length - 3] = forged[forged.length - 3]! ^ 1;
    const r = await verifier(client(), fetcher({ [fx.valid!.agent_uri as string]: okCard(forged) })).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "invalid", reasons: ["CARD_HASH_MISMATCH"] });
  });

  it("hostile on-chain agent_uri (a real <script> value from the registry) is never fetched", async () => {
    const hostile = { ...(fx.valid as object), agent_uri: fx.revoked!.agent_uri };
    let fetched = false;
    const spy: CardFetcher = { async fetch(u) { fetched = true; return createHardenedCardFetcher().fetch(u); } };
    const r = await verifier(client((t) => (t === "agent_of" ? { isError: false, value: hostile } : undefined)), spy).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "invalid", reasons: ["CARD_URL_REJECTED"] });
    expect(fetched).toBe(true); // the hardened fetcher refused it without any network call
  });

  it("a token from the other network's registry is untrusted here", async () => {
    const r = await verifier(client(), validFetcher).verify({ network: "testnet", tokenAddress: MAINNET_TOKEN, expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "invalid", reasons: ["UNTRUSTED_REGISTRY"] });
    const r2 = await verifier(client(), validFetcher).verify({ network: "mainnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r2).toMatchObject({ status: "invalid", reasons: ["UNTRUSTED_REGISTRY"] });
  });

  it("malformed token address: invalid before any network call", async () => {
    let called = false;
    const r = await verifier(client(() => { called = true; return undefined; }), validFetcher).verify({ network: "testnet", tokenAddress: "nope", expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "invalid", reasons: ["TOKEN_ADDRESS_INVALID"] });
    expect(called).toBe(false);
  });

  it("registry outage: unavailable. An error answer is not read as 'not found' either", async () => {
    const out = await verifier({ async call() { throw new UpstreamError("down"); } }, validFetcher).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(out).toMatchObject({ status: "unavailable", reasons: ["UPSTREAM_UNREACHABLE"] });
    const err = await verifier(client(() => ({ isError: true, value: "config error" })), validFetcher).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(err.status).toBe("unavailable");
  });

  it("a service answering about a different token than asked is not trusted", async () => {
    const r = await verifier(client(() => ({ isError: false, value: { ...(fx.valid as object), token_address: REVOKED_TOKEN } })), validFetcher).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r.status).toBe("unavailable");
  });

  it("matching hash but no badge: unverified (most real testnet cards look like this)", async () => {
    const noBadge = new TextEncoder().encode(JSON.stringify({ name: "x", capabilities: {} }));
    const rec = { ...(fx.valid as object), metadata_hash_hex: sha256Hex(noBadge) };
    const r = await verifier(client(() => ({ isError: false, value: rec })), fetcher({ [fx.valid!.agent_uri as string]: okCard(noBadge) })).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "unverified", reasons: ["BADGE_MISSING"] });
  });

  it("a card whose badge names someone else's token or owner: invalid even though its hash matches", async () => {
    const card = JSON.parse(new TextDecoder().decode(validCard));
    card.concordium.tokenAddress = `ccd:${TRUSTED_REGISTRIES.testnet.chainId}/cis-2:${REVOKED_TOKEN}`;
    const bytes = new TextEncoder().encode(JSON.stringify(card));
    const rec = { ...(fx.valid as object), metadata_hash_hex: sha256Hex(bytes) };
    const r = await verifier(client(() => ({ isError: false, value: rec })), fetcher({ [fx.valid!.agent_uri as string]: okCard(bytes) })).verify({ network: "testnet", tokenAddress: VALID_TOKEN, expectedOwnerAccount: owner });
    expect(r).toMatchObject({ status: "invalid", reasons: ["BADGE_MISMATCH"] });
  });
});

describe("badge parser", () => {
  const exp = { registry: TRUSTED_REGISTRIES.testnet, tokenAddress: VALID_TOKEN, ownerAccount: owner };
  const chain = `ccd:${TRUSTED_REGISTRIES.testnet.chainId}`;
  it("accepts the legacy block of a real card", () => expect(checkBadge(JSON.parse(new TextDecoder().decode(validCard)), exp)).toMatchObject({ present: true, embedding: "legacy", problems: [] }));
  it("accepts the sanctioned A2A extension form", () => {
    const card = { capabilities: { extensions: [{ uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1", params: { tokenAddress: `${chain}/cis-2:${VALID_TOKEN}`, owner: { account: `${chain}:${owner}` }, contracts: { cis8004: `${chain}:12802.0`, cis8: `${chain}:12801.0` } } }] } };
    expect(checkBadge(card, exp)).toMatchObject({ present: true, embedding: "extension", problems: [] });
  });
  it("rejects a different chain, owner or registry", () => {
    const base = { tokenAddress: `${chain}/cis-2:${VALID_TOKEN}`, owner: { account: owner }, contracts: { cis8004: "<12802,0>" } };
    expect(checkBadge({ concordium: { ...base, tokenAddress: `ccd:${TRUSTED_REGISTRIES.mainnet.chainId}/cis-2:${VALID_TOKEN}` } }, exp).problems).not.toEqual([]);
    expect(checkBadge({ concordium: { ...base, owner: { account: "3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB" } } }, exp).problems).toContain("Badge owner does not match the on-chain owner.");
    expect(checkBadge({ concordium: { ...base, contracts: { cis8004: "<999,0>" } } }, exp).problems).toContain("Badge points at a registry other than the trusted one.");
  });
  it("treats junk as no badge", () => { expect(checkBadge(null, exp).present).toBe(false); expect(checkBadge("x", exp).present).toBe(false); });
});

describe("hardened card fetching", () => {
  it("refuses unsafe URLs without touching the network", async () => {
    const f = createHardenedCardFetcher();
    for (const u of ["http://example.com/c.json", "https://localhost/c", "https://127.0.0.1/c", "https://[::1]/c", "https://u:p@example.com/c", "https://example.com:8443/c", fx.revoked!.agent_uri as string]) {
      expect((await f.fetch(u)).kind, u).toBe("rejected");
    }
  });
  it("the connect-time lookup refuses private answers (DNS rebinding) and passes public ones", async () => {
    const mk = (addr: string) => guardedLookup(((_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: addr, family: 4 }])) as never);
    const run = (l: ReturnType<typeof guardedLookup>, all: boolean) => new Promise<{ err: NodeJS.ErrnoException | null; out: unknown }>((res) => l("x.example", { all } as never, (err, out) => res({ err, out })));
    expect((await run(mk("10.0.0.5"), false)).err?.code).toBe("PRIVATE_ADDRESS");
    expect((await run(mk("169.254.169.254"), true)).err?.code).toBe("PRIVATE_ADDRESS");
    expect((await run(mk("93.184.216.34"), false)).out).toBe("93.184.216.34");
    expect((await run(mk("93.184.216.34"), true)).out).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("MCP client", () => {
  const sse = (obj: unknown) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
  it("initialises once, reuses the session, reads SSE tool results, and flags tool errors", async () => {
    const calls: string[] = [];
    const fake = (async (_u: string, init: { body: string; headers: Record<string, string> }) => {
      const b = JSON.parse(init.body); calls.push(b.method + (init.headers["mcp-session-id"] ? "@s" : ""));
      if (b.method === "initialize") return new Response(sse({ jsonrpc: "2.0", id: b.id, result: {} }), { headers: { "mcp-session-id": "S1" } });
      if (b.method === "notifications/initialized") return new Response("", { status: 202 });
      const isErr = b.params.arguments.bad;
      return new Response(sse({ jsonrpc: "2.0", id: b.id, result: { isError: !!isErr, content: [{ type: "text", text: isErr ? "boom" : JSON.stringify({ ok: 1 }) }] } }));
    }) as never;
    const c = createMcpClient({ url: "https://x.test/mcp", fetchImpl: fake });
    expect(await c.call("t", {})).toEqual({ isError: false, value: { ok: 1 } });
    expect(await c.call("t", { bad: true })).toEqual({ isError: true, value: "boom" });
    expect(calls.filter((x) => x.startsWith("initialize"))).toHaveLength(1);
  });
  it("turns network failures and 5xx into UpstreamError, and retries once on a stale session", async () => {
    await expect(createMcpClient({ url: "https://x.test/mcp", fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as never }).call("t", {})).rejects.toBeInstanceOf(UpstreamError);
    let n = 0;
    const stale = (async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      if (b.method === "initialize") return new Response(sse({ id: b.id, result: {} }), { headers: { "mcp-session-id": `S${++n}` } });
      if (b.method === "notifications/initialized") return new Response("", { status: 202 });
      return n === 1 ? new Response("gone", { status: 404 }) : new Response(sse({ id: b.id, result: { content: [{ type: "text", text: "1" }] } }));
    }) as never;
    expect(await createMcpClient({ url: "https://x.test/mcp", fetchImpl: stale }).call("t", {})).toEqual({ isError: false, value: 1 });
    await expect(createMcpClient({ url: "https://x.test/mcp", fetchImpl: (async () => new Response("down", { status: 503 })) as never }).call("t", {})).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("address encoding is the inverse of decoding (real vectors)", () => {
  it("re-creates the real badge strings", async () => {
    const { encodeTokenAddress, encodeAccountAddress } = await import("./index");
    expect(encodeTokenAddress({ contractIndex: 12802n, contractSubindex: 0n, tokenId: 43n })).toBe(VALID_TOKEN);
    expect(encodeTokenAddress({ contractIndex: 12802n, contractSubindex: 0n, tokenId: 11n })).toBe(REVOKED_TOKEN);
    expect(encodeTokenAddress({ contractIndex: 10082n, contractSubindex: 0n, tokenId: 0n })).toBe(MAINNET_TOKEN);
    const big = encodeTokenAddress({ contractIndex: 12802n, contractSubindex: 0n, tokenId: 123456789012345n });
    expect(decodeTokenAddress(big)).toEqual({ contractIndex: 12802n, contractSubindex: 0n, tokenId: 123456789012345n });
    expect(isAccountAddress(encodeAccountAddress(new Uint8Array(32).fill(7)))).toBe(true);
  });
});
