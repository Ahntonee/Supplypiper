import type { AgentRegistration, Prisma, PrismaClient, VerificationAttempt } from "@prisma/client";
import type { AgentVerifier, ConcordiumNetwork, ReasonCode, VerificationResult } from "@supplypiper/concordium";
import { NOT_ESTABLISHED_ALWAYS } from "@supplypiper/concordium";
import type { VerificationObservation, VerificationStatus } from "@supplypiper/domain";

/**
 * Organisation authority is a SEPARATE record from agent identity. It is valid only while it was granted for the owner
 * account we currently hold a proof for: if the owner changes (key rotation or transfer), the old grant is void.
 */
export const authorityValid = (r: Pick<AgentRegistration, "orgAuthorityBoundAt" | "ownerAccount" | "orgAuthorityOwnerAccount">): boolean =>
  !!r.orgAuthorityBoundAt && !!r.ownerAccount && r.orgAuthorityOwnerAccount === r.ownerAccount;

export interface StoredCheck {
  status: VerificationStatus; network: ConcordiumNetwork | "demo"; checkedAt: Date; reasons: ReasonCode[]; simulated: boolean;
  chainRef: VerificationResult["chainRef"] | null; established: string[]; notEstablished: string[];
}

export function fromAttempt(a: VerificationAttempt): StoredCheck {
  const j = (a.chainRef ?? {}) as { established?: string[]; notEstablished?: string[] } & NonNullable<VerificationResult["chainRef"]>;
  const { established, notEstablished, ...chainRef } = j;
  return {
    status: a.status as VerificationStatus, network: a.network as StoredCheck["network"], checkedAt: a.checkedAt, reasons: a.reasons as ReasonCode[], simulated: a.simulated,
    chainRef: Object.keys(chainRef).length ? (chainRef as StoredCheck["chainRef"]) : null, established: established ?? [], notEstablished: notEstablished ?? NOT_ESTABLISHED_ALWAYS,
  };
}

export interface VerificationService {
  /**
   * Always runs a new check unless `reuseWithinMs` is given, in which case a conclusive result no older than that is returned instead.
   * The result is persisted. No database transaction is held open during the network call.
   */
  check(reg: AgentRegistration, opts?: { reuseWithinMs?: number }): Promise<StoredCheck>;
  latest(agentId: string): Promise<StoredCheck | null>;
  observation(reg: AgentRegistration, c: StoredCheck): VerificationObservation;
  readonly freshnessMs: number;
}

export function createVerificationService(opts: { prisma: PrismaClient; verifier: AgentVerifier; freshnessMs: number; sourceLabel: string; now?: () => Date }): VerificationService {
  const now = opts.now ?? (() => new Date());
  const { prisma } = opts;
  return {
    freshnessMs: opts.freshnessMs,
    async latest(agentId) {
      const a = await prisma.verificationAttempt.findFirst({ where: { agentId }, orderBy: { checkedAt: "desc" } });
      return a ? fromAttempt(a) : null;
    },
    async check(reg, o = {}) {
      if (o.reuseWithinMs !== undefined) {
        const last = await prisma.verificationAttempt.findFirst({ where: { agentId: reg.id }, orderBy: { checkedAt: "desc" } });
        // Only a conclusive, recent result is reused. An outage result is never treated as an answer.
        if (last && last.status !== "unavailable" && now().getTime() - last.checkedAt.getTime() <= o.reuseWithinMs) return fromAttempt(last);
      }
      const r = await opts.verifier.verify({ network: reg.network as ConcordiumNetwork, tokenAddress: reg.tokenAddress, expectedOwnerAccount: reg.ownerAccount });
      const saved = await prisma.verificationAttempt.create({
        data: {
          agentId: reg.id, status: r.status, network: r.network, source: opts.sourceLabel, reasons: r.reasons, simulated: r.simulated, checkedAt: r.checkedAt,
          cardHashOk: r.reasons.includes("CHECK_OK") ? true : r.reasons.includes("CARD_HASH_MISMATCH") ? false : null,
          chainRef: { ...(r.chainRef ?? {}), established: r.established, notEstablished: r.notEstablished } as unknown as Prisma.InputJsonValue,
        },
      });
      return fromAttempt(saved);
    },
    observation(reg, c) {
      return { status: c.status, network: c.network, checkedAt: c.checkedAt, organisationAuthorityBound: authorityValid(reg), simulated: c.simulated };
    },
  };
}
