import { decodeTokenAddress, isAccountAddress } from "./address";
import { checkBadge } from "./badge";
import { cardHashMatches } from "./card";
import type { CardFetcher } from "./cardFetch";
import {
  NOT_ESTABLISHED_ALWAYS, TRUSTED_REGISTRIES, type AgentVerifier, type ConcordiumNetwork, type ReasonCode, type TrustedRegistry,
  type VerificationResult, type VerifyInput,
} from "./types";

/** The hosted registry could not be reached or answered with something we cannot interpret. */
export class UpstreamError extends Error {}

export interface RegistryClient { call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: unknown }> }

export interface McpClientOptions { url: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/** Minimal Streamable-HTTP MCP client for the hosted Agent Registry (read-only tools only are ever called by the verifier). */
export function createMcpClient(opts: McpClientOptions): RegistryClient {
  const f = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  let session: Promise<string | undefined> | null = null;
  let id = 0;

  async function post(body: unknown, sessionId?: string): Promise<{ text: string; sessionId?: string; status: number }> {
    let res: Response;
    try {
      res = await f(opts.url, {
        method: "POST", signal: AbortSignal.timeout(timeout),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) { throw new UpstreamError(`registry unreachable: ${(e as Error).message}`); }
    return { text: await res.text(), sessionId: res.headers.get("mcp-session-id") ?? undefined, status: res.status };
  }
  const parse = (text: string): { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown } => {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    try { return JSON.parse(line ? line.slice(5).trim() : text); } catch { throw new UpstreamError("registry returned an unreadable response"); }
  };
  async function init(): Promise<string | undefined> {
    const r = await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "supplypiper", version: "0.1.0" } } });
    if (r.status >= 400) throw new UpstreamError(`registry initialise failed (HTTP ${r.status})`);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, r.sessionId).catch(() => undefined);
    return r.sessionId;
  }

  return {
    async call(tool, args) {
      for (let attempt = 0; attempt < 2; attempt++) {
        session ??= init().catch((e) => { session = null; throw e; });
        const sid = await session;
        const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }, sid);
        if ((r.status === 404 || r.status === 400) && attempt === 0) { session = null; continue; } // stale session: start a new one once
        if (r.status >= 500) throw new UpstreamError(`registry error (HTTP ${r.status})`);
        const msg = parse(r.text);
        if (msg.error) throw new UpstreamError("registry rejected the request");
        const text = msg.result?.content?.[0]?.text;
        let value: unknown = text;
        try { value = text === undefined ? null : JSON.parse(text); } catch { /* plain-text error from the tool */ }
        return { isError: !!msg.result?.isError, value };
      }
      throw new UpstreamError("registry session could not be established");
    },
  };
}

interface AgentRecord {
  token_address?: string; owner_account?: string; agent_uri?: string | null; metadata_hash_hex?: string | null; status?: string; revocation_reason?: string;
}

export interface RegistryVerifierOptions {
  client: RegistryClient; cardFetcher: CardFetcher; registries?: Record<ConcordiumNetwork, TrustedRegistry>; now?: () => Date;
  /** Link shown to users as evidence. Observed working on 2026-11-10; it is Concordium-hosted, not ours. */
  evidenceUrl?: (tokenAddress: string) => string;
}

/**
 * Application-level agent check. Chain data comes from the hosted registry (`agent_of`), but every decision is ours:
 * we decode the token address ourselves, compare with our configured trusted registry, fetch and hash the card ourselves,
 * and compare the badge with the chain. The hosted service's own verdict tools are not used to decide.
 * This is an observation at one moment, not proof that the chain cannot change after it.
 */
export class RegistryVerifier implements AgentVerifier {
  private readonly registries; private readonly now; private readonly evidence;
  constructor(private readonly o: RegistryVerifierOptions) {
    this.registries = o.registries ?? TRUSTED_REGISTRIES;
    this.now = o.now ?? (() => new Date());
    this.evidence = o.evidenceUrl ?? ((t: string) => `https://agent-registry-mcp.concordium.com/v1/badge-check/${t}`);
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    const registry = this.registries[input.network];
    const established: string[] = [];
    const base = (status: VerificationResult["status"], reasons: ReasonCode[], chainRef?: VerificationResult["chainRef"]): VerificationResult => ({
      status, network: input.network, checkedAt: this.now(), reasons, simulated: false, established: [...established], notEstablished: NOT_ESTABLISHED_ALWAYS, chainRef,
    });
    const ref = (rec?: AgentRecord): NonNullable<VerificationResult["chainRef"]> => ({
      registry: `${registry.cis8004.index},${registry.cis8004.subindex}`, tokenAddress: input.tokenAddress, ownerAccount: rec?.owner_account,
      evidenceUrl: this.evidence(input.tokenAddress), metadataHashHex: rec?.metadata_hash_hex ?? undefined, agentUri: rec?.agent_uri ?? undefined,
      revocationReason: rec?.revocation_reason,
    });

    const decoded = decodeTokenAddress(input.tokenAddress);
    if (!decoded) return base("invalid", ["TOKEN_ADDRESS_INVALID"]);
    if (decoded.contractIndex !== BigInt(registry.cis8004.index) || decoded.contractSubindex !== BigInt(registry.cis8004.subindex)) return base("invalid", ["UNTRUSTED_REGISTRY"], ref());
    established.push(`The token belongs to the trusted CIS-8004 registry <${registry.cis8004.index},${registry.cis8004.subindex}> on ${input.network}`);

    if (!input.expectedOwnerAccount || !isAccountAddress(input.expectedOwnerAccount)) return base("unverified", ["OWNERSHIP_PROOF_MISSING"], ref());

    let rec: AgentRecord | null;
    try {
      const r = await this.o.client.call("agent_of", { network: input.network, token_id: decoded.tokenId.toString() });
      if (r.isError) return base("unavailable", ["UPSTREAM_UNREACHABLE"], ref()); // we cannot tell a bad request from an outage, so we do not guess
      rec = r.value as AgentRecord | null;
    } catch (e) {
      if (e instanceof UpstreamError) return base("unavailable", ["UPSTREAM_UNREACHABLE"], ref());
      throw e;
    }
    if (rec === null || typeof rec !== "object") return base("invalid", ["AGENT_NOT_FOUND"], ref());
    if (typeof rec.owner_account !== "string" || typeof rec.status !== "string" || rec.token_address !== input.tokenAddress) return base("unavailable", ["UPSTREAM_UNREACHABLE"], ref(rec));
    established.push("The agent exists on-chain");

    if (rec.status === "Revoked") return base("revoked", ["AGENT_REVOKED"], ref(rec));
    if (rec.status !== "Active") return base("invalid", ["AGENT_NOT_FOUND"], ref(rec));
    established.push("The agent is Active (not revoked)");

    if (rec.owner_account !== input.expectedOwnerAccount) return base("invalid", ["OWNER_MISMATCH"], ref(rec));
    established.push("The current on-chain owner is the owner our records bound after a wallet-signature proof");

    if (!rec.agent_uri || !rec.metadata_hash_hex) return base("unverified", ["CARD_UNREACHABLE"], ref(rec));
    const card = await this.o.cardFetcher.fetch(rec.agent_uri);
    if (card.kind === "rejected") return base("invalid", ["CARD_URL_REJECTED"], ref(rec));
    if (card.kind === "failed") return base(card.transient ? "unavailable" : "invalid", ["CARD_UNREACHABLE"], ref(rec));
    if (!cardHashMatches(card.bytes, rec.metadata_hash_hex)) return base("invalid", ["CARD_HASH_MISMATCH"], ref(rec));
    established.push("The published Agent Card matches its on-chain anchor (SHA-256 of the exact bytes served)");

    let json: unknown;
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(card.bytes)); } catch { return base("invalid", ["BADGE_MALFORMED"], ref(rec)); }
    const badge = checkBadge(json, { registry, tokenAddress: input.tokenAddress, ownerAccount: rec.owner_account });
    if (!badge.present) return base("unverified", ["BADGE_MISSING"], ref(rec));
    if (badge.problems.length) return base("invalid", ["BADGE_MISMATCH"], { ...ref(rec), badgeEmbedding: badge.embedding });
    established.push("The card's Concordium badge matches the on-chain record");
    return base("verified", ["CHECK_OK"], { ...ref(rec), badgeEmbedding: badge.embedding });
  }
}
