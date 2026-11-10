import type { VerificationStatus } from "@supplypiper/domain";

export type ConcordiumNetwork = "testnet" | "mainnet";

/** Trusted registry per network. Values observed via the hosted MCP `contract_info` on 2026-11-09. */
export interface TrustedRegistry {
  network: ConcordiumNetwork;
  cis8004: { index: number; subindex: number };
  cis8: { index: number; subindex: number };
  explorerBase: string;
  /** CAIP-2 chain id suffix (genesis hash prefix). Observed in registry badge data on 2026-11-10. */
  chainId: string;
}

export const TRUSTED_REGISTRIES: Record<ConcordiumNetwork, TrustedRegistry> = {
  testnet: { network: "testnet", cis8004: { index: 12802, subindex: 0 }, cis8: { index: 12801, subindex: 0 }, explorerBase: "https://testnet.ccdscan.io", chainId: "4221332d34e1694168c2a0c0b3fd0f27" },
  mainnet: { network: "mainnet", cis8004: { index: 10082, subindex: 0 }, cis8: { index: 10081, subindex: 0 }, explorerBase: "https://ccdscan.io", chainId: "9dd9ca4d19e9393877d2c44b70f89acb" },
};

export type ReasonCode =
  | "NOT_IMPLEMENTED" | "UPSTREAM_UNREACHABLE" | "UNTRUSTED_REGISTRY" | "WRONG_NETWORK"
  | "AGENT_NOT_FOUND" | "AGENT_REVOKED" | "OWNER_MISMATCH" | "CARD_UNREACHABLE"
  | "CARD_HASH_MISMATCH" | "CARD_URL_REJECTED" | "BADGE_MALFORMED" | "BADGE_MISSING" | "BADGE_MISMATCH" | "TOKEN_ADDRESS_INVALID" | "OWNERSHIP_PROOF_MISSING"
  | "CHECK_OK" | "DEMO_SIMULATED";

/** Application outcome. These are OUR statuses, not upstream enum values. */
export interface VerificationResult {
  status: VerificationStatus;
  network: ConcordiumNetwork | "demo";
  checkedAt: Date;
  reasons: ReasonCode[];
  simulated: boolean;
  /** Real references only; never fabricated. */
  chainRef?: { registry: string; tokenAddress: string; ownerAccount?: string; evidenceUrl?: string; metadataHashHex?: string; agentUri?: string; badgeEmbedding?: string; revocationReason?: string };
  /** What this check did and did not establish, shown verbatim in the UI. */
  established: string[];
  notEstablished: string[];
}

export const NOT_ESTABLISHED_ALWAYS = [
  "Product quality",
  "Business registration",
  "Ability to fulfil orders",
  "Solvency",
  "Endorsement by Concordium",
  "Authority to represent a named company (a separate organisation action)",
];

export interface VerifyInput { network: ConcordiumNetwork; tokenAddress: string; /** The owner our records bound after a wallet-signature proof. null means no proof exists. */ expectedOwnerAccount: string | null }
export interface AgentVerifier {
  verify(input: VerifyInput): Promise<VerificationResult>;
}

/** Used until the real adapter lands. Never returns "verified". */
export class NotImplementedVerifier implements AgentVerifier {
  async verify(input: { network: ConcordiumNetwork }): Promise<VerificationResult> {
    return {
      status: "unavailable", network: input.network, checkedAt: new Date(), reasons: ["NOT_IMPLEMENTED"],
      simulated: false, established: [], notEstablished: NOT_ESTABLISHED_ALWAYS,
    };
  }
}

/** Demo mode only. Result is always labelled simulated and network "demo". */
export class DemoVerifier implements AgentVerifier {
  async verify(): Promise<VerificationResult> {
    return {
      status: "verified", network: "demo", checkedAt: new Date(), reasons: ["DEMO_SIMULATED"], simulated: true,
      established: ["Nothing: this is a simulated demo result"], notEstablished: NOT_ESTABLISHED_ALWAYS,
    };
  }
}
