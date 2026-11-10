// LIVE smoke test against the real hosted registry and real card hosts on TESTNET. Read-only, no keys, no funds.
// Opt in with: LIVE_CONCORDIUM=1 npx vitest run packages/concordium/src/live.test.ts
// Without the flag every test here is reported as SKIPPED, never as passed.
import { generateKeyPairSync } from "node:crypto";
import { AccountAddress, buildBasicAccountSigner, signMessage } from "@concordium/web-sdk";
import { describe, expect, it } from "vitest";
import { buildChallenge, createGrpcAccountProvider, createHardenedCardFetcher, createMcpClient, RegistryVerifier, verifyOwnership } from "./index";
import fx from "../fixtures/agent_of.testnet.json";

const live = !!process.env.LIVE_CONCORDIUM;
if (!live) console.warn("SKIPPED: live Concordium checks (set LIVE_CONCORDIUM=1 to run them against testnet).");

describe.skipIf(!live)("live testnet verification (real registry, real card hosts)", () => {
  const verifier = new RegistryVerifier({ client: createMcpClient({ url: process.env.REGISTRY_MCP_URL ?? "https://agent-registry-mcp.concordium.com/mcp" }), cardFetcher: createHardenedCardFetcher() });
  const v = fx.valid!; const rv = fx.revoked!; const bc = fx.brokenCard!;

  it("a real agent with a matching card and badge verifies", async () => {
    const r = await verifier.verify({ network: "testnet", tokenAddress: "JyP9UhTu6PeHXpm6LAhSy", expectedOwnerAccount: v.owner_account as string });
    expect(r.status, JSON.stringify(r.reasons)).toBe("verified");
    expect(r.network).toBe("testnet");
  }, 60_000);

  it("a real revoked agent is reported revoked", async () => {
    const r = await verifier.verify({ network: "testnet", tokenAddress: "JyP9U6SVHZgayqA5XfHfA", expectedOwnerAccount: rv.owner_account as string });
    expect(r.status).toBe("revoked");
  }, 60_000);

  it("a real agent whose card host answers 404 is invalid", async () => {
    const r = await verifier.verify({ network: "testnet", tokenAddress: "JyP9TtQC3HCNrTYR3sc2T", expectedOwnerAccount: bc.owner_account as string });
    expect(r.status).toBe("invalid");
    expect(r.reasons).toContain("CARD_UNREACHABLE");
  }, 60_000);

  it("the wrong expected owner is refused for a real, otherwise valid agent", async () => {
    const r = await verifier.verify({ network: "testnet", tokenAddress: "JyP9UhTu6PeHXpm6LAhSy", expectedOwnerAccount: bc.owner_account as string });
    expect(r).toMatchObject({ status: "invalid", reasons: ["OWNER_MISMATCH"] });
  }, 60_000);

  it("real on-chain account keys are readable, and a signature from the wrong key is refused", async () => {
    const provider = await createGrpcAccountProvider();
    const account = v.owner_account as string;
    const info = await provider.getAccountInfo("testnet", account);
    expect(info?.accountAddress.address).toBe(account);
    const priv = (generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32).toString("hex");
    const c = buildChallenge({ orgId: "o", userId: "u", tokenAddress: "JyP9UhTu6PeHXpm6LAhSy", network: "testnet", audience: "live-test" });
    const signature = await signMessage(AccountAddress.fromBase58(account), c.message, buildBasicAccountSigner(priv));
    const verdict = await verifyOwnership({ storedMessage: c.message, submittedMessage: c.message, expiresAt: c.expiresAt, network: "testnet", account, signature, provider });
    expect(verdict).toEqual({ ok: false, reason: "BAD_SIGNATURE" }); // a positive proof needs a real wallet signature: see docs/integration-research.md
  }, 60_000);
});
