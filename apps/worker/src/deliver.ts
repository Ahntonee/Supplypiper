import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PermanentSendError, type EmailProvider } from "./providers";
import { renderEmail, UnrenderableError, type RenderContext } from "./templates";

/**
 * Database outbox delivery. Guarantees, stated plainly:
 *  - AT-LEAST-ONCE. An event is claimed with a lease (FOR UPDATE SKIP LOCKED), so two workers never hold the same event at once.
 *    If a worker dies after the provider accepted a message but before it recorded that, the lease expires and another worker sends
 *    again. The provider-side Message-ID and idempotency key (the outbox id) make such a duplicate recognisable. There is no
 *    "exactly once" promise.
 *  - Updates are FENCED by (state, lockedBy): a worker that lost its lease cannot overwrite the new owner's result.
 *  - Failures retry with exponential backoff and jitter, then dead-letter. Events that can never succeed are dead-lettered at once.
 */
export interface DeliverDeps {
  prisma: PrismaClient; provider: EmailProvider; render: RenderContext; workerId: string;
  batch: number; leaseMs: number; maxAttempts: number; allowedDomains: string[] | null;
  now?: () => Date; random?: () => number;
}

export interface BatchResult { claimed: number; delivered: number; failed: number; dead: number }
interface Claimed { id: string; topic: string; payload: unknown; attempts: number }

/** 30 s, 60 s, 2 min ... capped at 1 h, +/- 20% jitter so retries from many events do not synchronise. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Keeps stored errors useful but free of tokens and addresses. */
export function sanitizeError(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  return m.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]").slice(0, 200);
}

const emailPayload = z.object({ to: z.string().email().max(254), template: z.string().max(60), data: z.record(z.string(), z.unknown()) }).strict();
const ts = (d: Date) => d.toISOString();

export async function claim(d: DeliverDeps): Promise<Claimed[]> {
  const now = (d.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - d.leaseMs);
  // ISO strings cast to timestamp are UTC wall-clock, matching how the database stores these columns.
  return d.prisma.$queryRaw<Claimed[]>`
    UPDATE "OutboxEvent" o SET "state" = 'processing', "lockedAt" = ${ts(now)}::timestamp, "lockedBy" = ${d.workerId}, "attempts" = o."attempts" + 1
    WHERE o."id" IN (
      SELECT "id" FROM "OutboxEvent"
      WHERE ("state" IN ('pending', 'failed') AND "nextAttemptAt" <= ${ts(now)}::timestamp)
         OR ("state" = 'processing' AND "lockedAt" < ${ts(cutoff)}::timestamp)
      ORDER BY "nextAttemptAt" ASC LIMIT ${d.batch} FOR UPDATE SKIP LOCKED)
    RETURNING o."id", o."topic", o."payload", o."attempts"`;
}

type Outcome = "delivered" | "failed" | "dead";

async function finish(d: DeliverDeps, ev: Claimed, data: { state: "delivered" | "failed" | "dead"; lastError?: string; nextAttemptAt?: Date; providerMessageId?: string }): Promise<void> {
  const now = (d.now ?? (() => new Date()))();
  await d.prisma.outboxEvent.updateMany({
    // Fenced: only the worker that still holds the lease may record the outcome.
    where: { id: ev.id, state: "processing", lockedBy: d.workerId },
    data: { state: data.state, lastError: data.lastError ?? null, nextAttemptAt: data.nextAttemptAt, providerMessageId: data.providerMessageId, deliveredAt: data.state === "delivered" ? now : null, lockedAt: null, lockedBy: null },
  });
}

export async function processOne(d: DeliverDeps, ev: Claimed): Promise<Outcome> {
  const now = (d.now ?? (() => new Date()))();
  const dead = async (reason: string): Promise<Outcome> => { await finish(d, ev, { state: "dead", lastError: reason }); return "dead"; };
  if (ev.topic !== "email") return dead(`NO_HANDLER: topic "${ev.topic.slice(0, 40)}"`);
  const p = emailPayload.safeParse(ev.payload);
  if (!p.success) return dead("UNRENDERABLE: malformed payload");
  const domain = p.data.to.split("@")[1]!.toLowerCase();
  if (d.allowedDomains && !d.allowedDomains.includes(domain)) return dead("SUPPRESSED: recipient domain is not on the allowed list"); // never reaches a provider
  let mail;
  try { mail = renderEmail(p.data.template, p.data.data, d.render); }
  catch (e) { if (e instanceof UnrenderableError) return dead(`UNRENDERABLE: ${sanitizeError(e)}`); throw e; }
  try {
    const sent = await d.provider.send({ to: p.data.to, ...mail, idempotencyKey: ev.id });
    await finish(d, ev, { state: "delivered", providerMessageId: sent.providerMessageId });
    return "delivered";
  } catch (e) {
    const err = sanitizeError(e);
    if (e instanceof PermanentSendError) return dead(`PERMANENT: ${err}`);
    if (ev.attempts >= d.maxAttempts) return dead(`MAX_ATTEMPTS (${ev.attempts}): ${err}`);
    await finish(d, ev, { state: "failed", lastError: `TRANSIENT: ${err}`, nextAttemptAt: new Date(now.getTime() + backoffMs(ev.attempts, d.random)) });
    return "failed";
  }
}

/** Claims one batch and processes it. An unexpected error in one event does not stop the others or lose that event. */
export async function runOnce(d: DeliverDeps): Promise<BatchResult> {
  const events = await claim(d);
  const r: BatchResult = { claimed: events.length, delivered: 0, failed: 0, dead: 0 };
  for (const ev of events) {
    try { r[await processOne(d, ev)]++; }
    catch (e) {
      // Unknown failure: leave a trace and retry later rather than hang in "processing" until the lease expires.
      r.failed++;
      await finish(d, ev, { state: ev.attempts >= d.maxAttempts ? "dead" : "failed", lastError: `UNEXPECTED: ${sanitizeError(e)}`, nextAttemptAt: new Date((d.now ?? (() => new Date()))().getTime() + backoffMs(ev.attempts, d.random)) });
    }
  }
  return r;
}

export async function heartbeat(prisma: PrismaClient, name: string, startedAt: Date, delta: { processed: number; failed: number }, now: Date = new Date()): Promise<void> {
  await prisma.workerHeartbeat.upsert({
    where: { name }, create: { name, startedAt, lastBeatAt: now, processed: delta.processed, failed: delta.failed },
    update: { lastBeatAt: now, processed: { increment: delta.processed }, failed: { increment: delta.failed } },
  });
}

/** Operator action for a dead-lettered event, after the cause is fixed. Resets the attempt counter and makes it due now. */
export async function requeueDead(prisma: PrismaClient, id: string, now: Date = new Date()): Promise<boolean> {
  const r = await prisma.outboxEvent.updateMany({ where: { id, state: "dead" }, data: { state: "pending", attempts: 0, nextAttemptAt: now, lastError: null, lockedAt: null, lockedBy: null } });
  return r.count === 1;
}

export async function backlog(prisma: PrismaClient) {
  const rows = await prisma.outboxEvent.groupBy({ by: ["state"], _count: true });
  const n = (s: string) => rows.find((r) => r.state === s)?._count ?? 0;
  return { pending: n("pending"), processing: n("processing"), failed: n("failed"), dead: n("dead"), delivered: n("delivered") };
}
