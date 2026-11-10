import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AccountTransactionSignature } from "@concordium/web-sdk";
import {
  buildChallenge, decodeTokenAddress, hashNonce, TRUSTED_REGISTRIES, verifyOwnership, type AccountInfoProvider, type ConcordiumNetwork,
} from "@supplypiper/concordium";
import { getAuth, requireSession } from "./auth";
import { authorityValid, type StoredCheck, type VerificationService } from "./agentVerification";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { audit, validate } from "./helpers";
import { param } from "./loaders";
import { getScope, requireOrgPermission } from "./orgs";
import { ser } from "./serialize";

/** Mainnet only in production; testnet everywhere else. Testnet identities are never presented as production KYC. */
export const allowedNetworks = (mode: AppConfig["mode"]): ConcordiumNetwork[] => (mode === "production" ? ["mainnet"] : ["testnet"]);

const signatureSchema = z.record(z.string().regex(/^\d+$/), z.record(z.string().regex(/^\d+$/), z.string().regex(/^[0-9a-fA-F]{128}$/, "Not a valid signature"))).refine((s) => Object.keys(s).length > 0, "Empty signature");

export interface AgentsDeps { verification: VerificationService | undefined; accountProvider: AccountInfoProvider | undefined; audience: string }

export function presentCheck(c: StoredCheck | null, freshnessMs: number, now = new Date()) {
  if (!c) return null;
  const ageMs = now.getTime() - c.checkedAt.getTime();
  return {
    status: c.status, network: c.network, checkedAt: c.checkedAt, ageSeconds: Math.round(ageMs / 1000), freshForOrders: c.status === "verified" && ageMs <= freshnessMs,
    reasons: c.reasons, simulated: c.simulated, evidenceUrl: c.chainRef?.evidenceUrl ?? null, badgeEmbedding: c.chainRef?.badgeEmbedding ?? null,
    revocationReason: c.chainRef?.revocationReason ?? null, established: c.established, notEstablished: c.notEstablished,
  };
}

export function agentsRouter(prisma: PrismaClient, config: AppConfig, deps: AgentsDeps): Router {
  const r = Router();
  r.use(requireSession);

  const own = async (orgId: string, id: string) => {
    const reg = await prisma.agentRegistration.findFirst({ where: { id, orgId } });
    if (!reg) throw new ApiError(404, "NOT_FOUND", "Agent not found");
    return reg;
  };
  const present = async (reg: Awaited<ReturnType<typeof own>>) => ({
    id: reg.id, network: reg.network, tokenAddress: reg.tokenAddress, registry: reg.registry, operatorType: reg.operatorType,
    operatorNote: reg.operatorType === "platform_operated" ? "Operated by the SupplyPiper platform. This is not independent supplier ownership." : "Operated by the supplier.",
    ownerAccount: reg.ownerAccount, ownerProvedAt: reg.ownerProvedAt,
    authority: { bound: authorityValid(reg), boundAt: reg.orgAuthorityBoundAt, voidBecauseOwnerChanged: !!reg.orgAuthorityBoundAt && !authorityValid(reg) },
    latestCheck: presentCheck(await deps.verification?.latest(reg.id) ?? null, deps.verification?.freshnessMs ?? 0),
    lastSuccessfulCheckAt: (await prisma.verificationAttempt.findFirst({ where: { agentId: reg.id, status: "verified" }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true } }))?.checkedAt ?? null,
    checksAvailable: !!deps.verification,
  });

  r.post("/orgs/:orgId/agents", requireOrgPermission(prisma, "agent.manage"), async (req, res) => {
    const b = validate(z.object({ network: z.enum(["testnet", "mainnet"]), tokenAddress: z.string().trim().min(10).max(60), operatorType: z.enum(["supplier_owned", "platform_operated"]) }), req.body);
    const s = getScope(res);
    if (!allowedNetworks(config.mode).includes(b.network)) throw new ApiError(422, "NETWORK_NOT_ALLOWED", `This environment uses ${allowedNetworks(config.mode).join(" / ")} only`);
    const registry = TRUSTED_REGISTRIES[b.network];
    const d = decodeTokenAddress(b.tokenAddress);
    if (!d) throw new ApiError(400, "VALIDATION_FAILED", "That is not a valid agent token address", { tokenAddress: "Check the badge string and try again" });
    if (d.contractIndex !== BigInt(registry.cis8004.index) || d.contractSubindex !== BigInt(registry.cis8004.subindex)) {
      throw new ApiError(422, "UNTRUSTED_REGISTRY", `This token is not in the trusted ${b.network} agent registry`);
    }
    if (await prisma.agentRegistration.findUnique({ where: { network_tokenAddress: { network: b.network, tokenAddress: b.tokenAddress } } })) {
      throw new ApiError(409, "AGENT_ALREADY_REGISTERED", "This agent is already registered with SupplyPiper");
    }
    const reg = await prisma.$transaction(async (tx) => {
      const x = await tx.agentRegistration.create({ data: { orgId: s.orgId, operatorType: b.operatorType, network: b.network, registry: `${registry.cis8004.index},${registry.cis8004.subindex}`, tokenAddress: b.tokenAddress, registeredByUserId: getAuth(res).user.id } });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "agent.registered", objectType: "AgentRegistration", objectId: x.id, payload: { network: b.network, tokenAddress: b.tokenAddress } });
      return x;
    });
    res.status(201).json(ser(await present(reg)));
  });

  r.get("/orgs/:orgId/agents", requireOrgPermission(prisma, "catalogue.view"), async (_req, res) => {
    const regs = await prisma.agentRegistration.findMany({ where: { orgId: getScope(res).orgId }, orderBy: { createdAt: "desc" } });
    res.json(ser({ agents: await Promise.all(regs.map(present)), environment: { networks: allowedNetworks(config.mode), freshnessSeconds: config.verificationFreshnessMs / 1000 } }));
  });

  r.post("/orgs/:orgId/agents/:id/challenge", requireOrgPermission(prisma, "agent.manage"), async (req, res) => {
    const s = getScope(res); const reg = await own(s.orgId, param(req, "id"));
    const c = buildChallenge({ orgId: s.orgId, userId: getAuth(res).user.id, tokenAddress: reg.tokenAddress, network: reg.network as ConcordiumNetwork, audience: deps.audience });
    const row = await prisma.ownershipChallenge.create({ data: { agentId: reg.id, orgId: s.orgId, userId: getAuth(res).user.id, network: reg.network, tokenAddress: reg.tokenAddress, nonceHash: hashNonce(c.nonce), message: c.message, expiresAt: c.expiresAt } });
    res.status(201).json(ser({ challengeId: row.id, message: c.message, expiresAt: c.expiresAt, how: "Sign this exact message with the Concordium account that owns the agent, using your wallet's message-signing function. Never share a seed phrase or private key; the signature alone is enough." }));
  });

  r.post("/orgs/:orgId/agents/:id/ownership", requireOrgPermission(prisma, "agent.manage"), async (req, res) => {
    const b = validate(z.object({ challengeId: z.string().uuid(), account: z.string().trim().min(40).max(60), message: z.string().max(2000), signature: signatureSchema }), req.body);
    const s = getScope(res); const user = getAuth(res).user; const reg = await own(s.orgId, param(req, "id"));
    if (!deps.accountProvider) throw new ApiError(503, "CHAIN_UNAVAILABLE", "Ownership proofs cannot be checked in this environment");
    const ch = await prisma.ownershipChallenge.findFirst({ where: { id: b.challengeId, agentId: reg.id, orgId: s.orgId, userId: user.id } });
    if (!ch || ch.usedAt) throw new ApiError(400, "CHALLENGE_INVALID", "This challenge is unknown or was already used. Request a new one.");
    const verdict = await verifyOwnership({ storedMessage: ch.message, submittedMessage: b.message, expiresAt: ch.expiresAt, network: reg.network as ConcordiumNetwork, account: b.account, signature: b.signature as unknown as AccountTransactionSignature, provider: deps.accountProvider });
    if (!verdict.ok) {
      await audit(prisma, res, { orgId: s.orgId, actorUserId: user.id, event: "agent.ownership_proof_failed", objectType: "AgentRegistration", objectId: reg.id, payload: { reason: verdict.reason } });
      if (verdict.reason === "CHAIN_UNAVAILABLE") throw new ApiError(503, "CHAIN_UNAVAILABLE", "The Concordium node could not be reached. Try again shortly; your challenge is still valid.");
      throw new ApiError(400, "OWNERSHIP_PROOF_FAILED", "The signature could not be verified for that account", { reason: verdict.reason });
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.ownershipChallenge.updateMany({ where: { id: ch.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new ApiError(400, "CHALLENGE_INVALID", "This challenge was already used.");
      const ownerChanged = !!reg.ownerAccount && reg.ownerAccount !== b.account;
      await tx.agentRegistration.update({
        where: { id: reg.id },
        data: { ownerAccount: b.account, ownerProvedAt: new Date(), ownerProofUserId: user.id, ownerProofNonceUsed: ch.nonceHash, ...(ownerChanged || reg.orgAuthorityOwnerAccount !== b.account ? { orgAuthorityBoundAt: null, orgAuthorityBoundBy: null, orgAuthorityOwnerAccount: null } : {}) },
      });
      await audit(tx, res, { orgId: s.orgId, actorUserId: user.id, event: ownerChanged ? "agent.owner_changed_authority_cleared" : "agent.owner_proved", objectType: "AgentRegistration", objectId: reg.id, payload: { account: b.account } });
    });
    res.json(ser(await present(await own(s.orgId, reg.id))));
  });

  r.post("/orgs/:orgId/agents/:id/check", requireOrgPermission(prisma, "agent.manage"), async (req, res) => {
    const s = getScope(res); const reg = await own(s.orgId, param(req, "id"));
    if (!deps.verification) throw new ApiError(503, "VERIFICATION_UNAVAILABLE", "Agent verification is not available in this environment");
    // A repeat click within a few seconds shows the same conclusive result instead of hammering the registry.
    await deps.verification.check(reg, { reuseWithinMs: 5000 });
    await audit(prisma, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "agent.verification_checked", objectType: "AgentRegistration", objectId: reg.id });
    res.json(ser(await present(reg)));
  });

  r.post("/orgs/:orgId/agents/:id/authorise", requireOrgPermission(prisma, "agent.authorise"), async (req, res) => {
    validate(z.object({ confirm: z.literal(true, { message: "Confirm that this agent may quote for your organisation" }) }), req.body);
    const s = getScope(res); const user = getAuth(res).user; const reg = await own(s.orgId, param(req, "id"));
    if (!reg.ownerAccount || !reg.ownerProvedAt) throw new ApiError(409, "OWNER_NOT_PROVEN", "Prove who owns the agent before authorising it to quote for your organisation");
    await prisma.$transaction(async (tx) => {
      await tx.agentRegistration.update({ where: { id: reg.id }, data: { orgAuthorityBoundAt: new Date(), orgAuthorityBoundBy: user.id, orgAuthorityOwnerAccount: reg.ownerAccount } });
      await audit(tx, res, { orgId: s.orgId, actorUserId: user.id, event: "agent.authority_granted", objectType: "AgentRegistration", objectId: reg.id, payload: { ownerAccount: reg.ownerAccount } });
    });
    res.json(ser(await present(await own(s.orgId, reg.id))));
  });

  r.post("/orgs/:orgId/agents/:id/withdraw-authority", requireOrgPermission(prisma, "agent.authorise"), async (req, res) => {
    const s = getScope(res); const reg = await own(s.orgId, param(req, "id"));
    await prisma.$transaction(async (tx) => {
      await tx.agentRegistration.update({ where: { id: reg.id }, data: { orgAuthorityBoundAt: null, orgAuthorityBoundBy: null, orgAuthorityOwnerAccount: null } });
      await audit(tx, res, { orgId: s.orgId, actorUserId: getAuth(res).user.id, event: "agent.authority_withdrawn", objectType: "AgentRegistration", objectId: reg.id });
    });
    res.json(ser(await present(await own(s.orgId, reg.id))));
  });

  return r;
}
