import { createHash, randomBytes } from "node:crypto";
import { AccountAddress, verifyMessageSignature, type AccountInfo, type AccountTransactionSignature } from "@concordium/web-sdk";
import { isAccountAddress } from "./address";
import type { ConcordiumNetwork } from "./types";

/**
 * Proof that the person configuring an agent controls the Concordium account that owns it.
 * A pasted address proves nothing; a signature over a one-time, expiring, context-bound message does.
 * The wallet signs with the standard account message signing of the Concordium SDK; we verify it against the
 * account's CURRENT on-chain keys, so a rotated key stops working without any action by us.
 */
export const CHALLENGE_TTL_MS = 10 * 60_000;

export interface ChallengeContext { orgId: string; userId: string; tokenAddress: string; network: ConcordiumNetwork; audience: string }
export interface Challenge { nonce: string; message: string; expiresAt: Date }

/** Contains opaque ids only: no names, emails or business details. */
export function buildChallenge(ctx: ChallengeContext, now: Date = new Date(), nonce: string = randomBytes(24).toString("base64url")): Challenge {
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const message = [
    "SupplyPiper agent ownership proof",
    `Audience: ${ctx.audience}`,
    `Network: ${ctx.network}`,
    `Agent token: ${ctx.tokenAddress}`,
    `Organisation: ${ctx.orgId}`,
    `User: ${ctx.userId}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    "Signing proves you control this account for SupplyPiper. It does not move funds or grant any other permission.",
  ].join("\n");
  return { nonce, message, expiresAt };
}

export const hashNonce = (nonce: string) => createHash("sha256").update(nonce).digest("base64");

export interface AccountInfoProvider { getAccountInfo(network: ConcordiumNetwork, account: string): Promise<AccountInfo | null> }

export type OwnershipVerdict = { ok: true } | { ok: false; reason: "BAD_ACCOUNT" | "EXPIRED" | "MESSAGE_MISMATCH" | "ACCOUNT_NOT_FOUND" | "BAD_SIGNATURE" | "CHAIN_UNAVAILABLE" };

export interface OwnershipInput {
  /** The message the SERVER stored for this nonce. The client's copy is never trusted. */
  storedMessage: string; submittedMessage: string; expiresAt: Date; now?: Date;
  network: ConcordiumNetwork; account: string; signature: AccountTransactionSignature; provider: AccountInfoProvider;
}

export async function verifyOwnership(i: OwnershipInput): Promise<OwnershipVerdict> {
  if (!isAccountAddress(i.account)) return { ok: false, reason: "BAD_ACCOUNT" };
  if ((i.now ?? new Date()).getTime() >= i.expiresAt.getTime()) return { ok: false, reason: "EXPIRED" };
  if (i.submittedMessage !== i.storedMessage) return { ok: false, reason: "MESSAGE_MISMATCH" };
  let info: AccountInfo | null;
  try { info = await i.provider.getAccountInfo(i.network, i.account); } catch { return { ok: false, reason: "CHAIN_UNAVAILABLE" }; }
  if (!info) return { ok: false, reason: "ACCOUNT_NOT_FOUND" };
  try {
    return (await verifyMessageSignature(i.storedMessage, i.signature, info)) ? { ok: true } : { ok: false, reason: "BAD_SIGNATURE" };
  } catch { return { ok: false, reason: "BAD_SIGNATURE" }; }
}

export interface GrpcEndpoints { testnet: { host: string; port: number }; mainnet: { host: string; port: number } }
/** Endpoints observed in the registry's `agent_registry_capabilities` on 2026-11-09. Override via configuration. */
export const DEFAULT_GRPC: GrpcEndpoints = { testnet: { host: "grpc.testnet.concordium.com", port: 20000 }, mainnet: { host: "grpc.mainnet.concordium.software", port: 20000 } };

/** Reads an account's current keys from a Concordium node over gRPC (read-only). */
export async function createGrpcAccountProvider(endpoints: GrpcEndpoints = DEFAULT_GRPC): Promise<AccountInfoProvider> {
  const { ConcordiumGRPCNodeClient } = await import("@concordium/web-sdk/nodejs");
  const { credentials } = await import("@grpc/grpc-js");
  const clients = new Map<ConcordiumNetwork, InstanceType<typeof ConcordiumGRPCNodeClient>>();
  return {
    async getAccountInfo(network, account) {
      let c = clients.get(network);
      if (!c) { const e = endpoints[network]; c = new ConcordiumGRPCNodeClient(e.host, e.port, credentials.createSsl(), { timeout: 15_000 }); clients.set(network, c); }
      try { return await c.getAccountInfo(AccountAddress.fromBase58(account)); }
      catch (err) {
        if (/not found|NOT_FOUND/i.test(String((err as Error).message))) return null;
        throw err;
      }
    },
  };
}
