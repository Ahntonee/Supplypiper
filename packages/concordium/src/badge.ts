import type { TrustedRegistry } from "./types";

export const BADGE_EXTENSION_URI = "https://docs.concordium.com/a2a-extensions/concordium-badge/v1";

export interface BadgeExpectation { registry: TrustedRegistry; tokenAddress: string; ownerAccount: string }
export interface BadgeCheck { present: boolean; embedding: "extension" | "legacy" | "none"; problems: string[] }

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Parses "12802.0" (extension, after the CAIP-10 prefix) or "<12802,0>" (legacy) into a contract pair. */
function parseContract(raw: string | null, chainId: string): { index: number; subindex: number } | null {
  if (!raw) return null;
  const legacy = /^<(\d+),(\d+)>$/.exec(raw);
  if (legacy) return { index: Number(legacy[1]), subindex: Number(legacy[2]) };
  const caip = new RegExp(`^ccd:${chainId}:(\\d+)\\.(\\d+)$`).exec(raw);
  return caip ? { index: Number(caip[1]), subindex: Number(caip[2]) } : null;
}

/**
 * Checks that the card's badge describes THIS on-chain agent. The card is an untrusted claim: every field is compared
 * with what the chain and our own trusted-registry configuration say. Accepts the sanctioned A2A extension form and the
 * legacy top-level `concordium` block (the spec asks verifiers to accept both).
 */
export function checkBadge(card: unknown, expected: BadgeExpectation): BadgeCheck {
  const c = asRecord(card);
  const chain = `ccd:${expected.registry.chainId}`;
  const extensions = asRecord(c?.capabilities)?.extensions;
  const ext = Array.isArray(extensions) ? extensions.map(asRecord).find((e) => e?.uri === BADGE_EXTENSION_URI) : undefined;
  const params = asRecord(ext?.params);
  const legacy = asRecord(c?.concordium);
  const embedding: BadgeCheck["embedding"] = params ? "extension" : legacy ? "legacy" : "none";
  const b = params ?? legacy;
  if (!b) return { present: false, embedding: "none", problems: ["The card carries no Concordium badge."] };

  const problems: string[] = [];
  const token = asString(b.tokenAddress);
  const m = token ? new RegExp(`^${chain}/cis-2:([1-9A-HJ-NP-Za-km-z]+)$`).exec(token) : null;
  if (!m) problems.push("Badge token address is missing, malformed, or for a different chain.");
  else if (m[1] !== expected.tokenAddress) problems.push("Badge names a different token than the one on-chain.");

  const owner = asRecord(b.owner);
  const ownerRaw = asString(owner?.caip10) ?? asString(owner?.account);
  const ownerAccount = ownerRaw?.startsWith("ccd:") ? ownerRaw.slice(ownerRaw.lastIndexOf(":") + 1) : ownerRaw;
  if (ownerRaw?.startsWith("ccd:") && !ownerRaw.startsWith(`${chain}:`)) problems.push("Badge owner is on a different chain.");
  if (ownerAccount !== expected.ownerAccount) problems.push("Badge owner does not match the on-chain owner.");

  const contracts = asRecord(b.contracts);
  const reg = parseContract(asString(contracts?.cis8004), expected.registry.chainId);
  if (!reg || reg.index !== expected.registry.cis8004.index || reg.subindex !== expected.registry.cis8004.subindex) problems.push("Badge points at a registry other than the trusted one.");

  const declaredChain = asString(b.chain);
  if (declaredChain && declaredChain !== chain) problems.push("Badge declares a different chain.");
  return { present: true, embedding, problems };
}
