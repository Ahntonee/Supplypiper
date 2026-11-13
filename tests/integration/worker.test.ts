import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";
import { backlog, claim, heartbeat, processOne, requeueDead, runOnce, type DeliverDeps } from "../../apps/worker/src/deliver";
import { DevInboxProvider, PermanentSendError, SmtpProvider, TransientSendError, type EmailProvider, type OutgoingEmail } from "../../apps/worker/src/providers";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://supplypiper:devonly@127.0.0.1:54329/supplypiper_test";
const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let dbUp = false;
try { await prisma.$queryRaw`SELECT 1`; dbUp = true; } catch { /* reported as SKIPPED below */ }
if (!dbUp) console.warn("SKIPPED: integration tests need PostgreSQL at TEST_DATABASE_URL (run `npm run db:dev`).");
const d = describe.skipIf(!dbUp);

const uuid = () => randomUUID();
const OLD = new Date("2000-01-01T00:00:00Z"); // sorts ahead of any leftover rows so a small batch reaches ours first
const rfq = (to: string) => ({ to, template: "rfq_invited", data: { requestId: uuid() } });

/** Records every attempted send per outbox id and can be told how to behave per recipient. */
class FakeProvider implements EmailProvider {
  readonly name = "fake"; readonly kind = "dev" as const;
  calls = new Map<string, number>();
  constructor(private readonly behave: (e: OutgoingEmail) => void | Promise<void> = () => {}) {}
  async send(e: OutgoingEmail) { this.calls.set(e.idempotencyKey, (this.calls.get(e.idempotencyKey) ?? 0) + 1); await this.behave(e); return { providerMessageId: `fake:${e.idempotencyKey}` }; }
}

d("email worker against real PostgreSQL", () => {
  beforeAll(() => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe", shell: true });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  const deps = (provider: EmailProvider, over: Partial<DeliverDeps> = {}): DeliverDeps => ({
    prisma, provider, workerId: `w-${uuid().slice(0, 8)}`, render: { baseUrl: "https://app.example.test", modeLabel: "[Demo] " },
    batch: 200, leaseMs: 120_000, maxAttempts: 3, allowedDomains: null, random: () => 0.5, ...over,
  });
  const make = async (payload: unknown, o: { topic?: string; state?: "pending" | "processing" | "failed" | "dead"; attempts?: number; lockedAt?: Date; lockedBy?: string } = {}) =>
    (await prisma.outboxEvent.create({ data: { topic: o.topic ?? "email", payload: payload as object, nextAttemptAt: OLD, state: o.state ?? "pending", attempts: o.attempts ?? 0, lockedAt: o.lockedAt, lockedBy: o.lockedBy } })).id;
  const get = (id: string) => prisma.outboxEvent.findUniqueOrThrow({ where: { id } });

  it("delivers through the development provider and records the outcome", async () => {
    const id = await make(rfq("buyer@example.test"));
    const r = await runOnce(deps(new DevInboxProvider(prisma)));
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const ev = await get(id);
    expect(ev.state).toBe("delivered");
    expect(ev.providerMessageId).toBe(`dev:${id}`);
    expect(ev.deliveredAt).not.toBeNull();
    expect(ev.lockedBy).toBeNull();
    const mail = await prisma.sentEmail.findUniqueOrThrow({ where: { outboxId: id } });
    expect(mail.to).toBe("buyer@example.test");
    expect(mail.subject.startsWith("[Demo] ")).toBe(true);
  });

  it("sending the same event twice through the dev provider stores one message (idempotent)", async () => {
    const id = await make(rfq("dup@example.test"));
    const p = new DevInboxProvider(prisma);
    const mail = { to: "dup@example.test", subject: "s", text: "t", html: "h", idempotencyKey: id };
    await p.send(mail); await p.send(mail);
    expect(await prisma.sentEmail.count({ where: { outboxId: id } })).toBe(1);
  });

  it("three concurrent workers never send the same event twice", async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => make(rfq("race@example.test"))));
    const provider = new FakeProvider(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const ws = [1, 2, 3].map((i) => deps(provider, { workerId: `race-${i}-${uuid().slice(0, 4)}`, batch: 8 }));
    await Promise.all(ws.map(async (w) => { for (let i = 0; i < 12; i++) await runOnce(w); }));
    for (const id of ids) { expect(provider.calls.get(id)).toBe(1); expect((await get(id)).state).toBe("delivered"); }
  });

  it("a transient failure is retried later with backoff, then succeeds", async () => {
    const id = await make(rfq("flaky@example.test"));
    let fail = true;
    const provider = new FakeProvider(() => { if (fail) throw new TransientSendError("smtp 451"); });
    const now = new Date();
    await runOnce(deps(provider, { now: () => now }));
    let ev = await get(id);
    expect(ev.state).toBe("failed");
    expect(ev.attempts).toBe(1);
    expect(ev.lastError).toMatch(/^TRANSIENT/);
    expect(ev.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    // Not due yet: a run at the same instant leaves it alone.
    await runOnce(deps(provider, { now: () => now }));
    expect(provider.calls.get(id)).toBe(1);
    fail = false;
    await runOnce(deps(provider, { now: () => new Date(now.getTime() + 3_600_000) }));
    ev = await get(id);
    expect(ev.state).toBe("delivered");
    expect(ev.attempts).toBe(2);
    expect(ev.lastError).toBeNull();
  });

  it("a permanent failure is dead-lettered at once, without retrying", async () => {
    const id = await make(rfq("bad@example.test"));
    const provider = new FakeProvider(() => { throw new PermanentSendError("smtp 550"); });
    await runOnce(deps(provider));
    const ev = await get(id);
    expect(ev.state).toBe("dead");
    expect(ev.lastError).toMatch(/^PERMANENT/);
    expect(provider.calls.get(id)).toBe(1);
  });

  it("gives up after the maximum number of attempts", async () => {
    const id = await make(rfq("never@example.test"));
    const provider = new FakeProvider(() => { throw new TransientSendError("network ECONNREFUSED"); });
    let t = Date.now();
    for (let i = 0; i < 5; i++) { await runOnce(deps(provider, { now: () => new Date(t) })); t += 4_000_000; }
    const ev = await get(id);
    expect(ev.state).toBe("dead");
    expect(ev.attempts).toBe(3);
    expect(ev.lastError).toMatch(/^MAX_ATTEMPTS/);
    expect(provider.calls.get(id)).toBe(3);
  });

  it("dead-letters events that can never be handled and never calls the provider", async () => {
    const unknownTopic = await make({}, { topic: "sms" });
    const malformed = await make({ nope: true });
    const unknownTemplate = await make({ to: "x@example.test", template: "made_up", data: {} });
    const extraData = await make({ to: "x@example.test", template: "order_created", data: { orderId: uuid(), total: "99" } });
    const provider = new FakeProvider();
    await runOnce(deps(provider));
    for (const id of [unknownTopic, malformed, unknownTemplate, extraData]) { expect((await get(id)).state).toBe("dead"); expect(provider.calls.has(id)).toBe(false); }
    expect((await get(unknownTopic)).lastError).toMatch(/^NO_HANDLER/);
    expect((await get(unknownTemplate)).lastError).toMatch(/^UNRENDERABLE/);
  });

  it("suppresses recipients outside the allowed domains before any provider is reached", async () => {
    const out = await make(rfq("someone@stranger.test"));
    const inn = await make(rfq("pilot@allowed.test"));
    const provider = new FakeProvider();
    await runOnce(deps(provider, { allowedDomains: ["allowed.test"] }));
    expect((await get(out)).state).toBe("dead");
    expect((await get(out)).lastError).toMatch(/^SUPPRESSED/);
    expect(provider.calls.has(out)).toBe(false);
    expect((await get(inn)).state).toBe("delivered");
  });

  it("recovers an abandoned event after its lease expires but never steals a fresh lock", async () => {
    const stale = await make(rfq("stale@example.test"), { state: "processing", attempts: 1, lockedAt: new Date(Date.now() - 600_000), lockedBy: "dead-worker" });
    const fresh = await make(rfq("fresh@example.test"), { state: "processing", attempts: 1, lockedAt: new Date(), lockedBy: "live-worker" });
    const provider = new FakeProvider();
    await runOnce(deps(provider, { leaseMs: 120_000 }));
    expect((await get(stale)).state).toBe("delivered");
    expect((await get(stale)).attempts).toBe(2);
    expect(provider.calls.has(fresh)).toBe(false);
    const f = await get(fresh);
    expect(f.state).toBe("processing");
    expect(f.lockedBy).toBe("live-worker");
  });

  it("fences updates: a worker that lost its lease cannot overwrite the new owner", async () => {
    const id = await make(rfq("fence@example.test"));
    const a = deps(new FakeProvider(), { workerId: "worker-a" });
    const [claimed] = (await claim({ ...a, batch: 1 })).filter((c) => c.id === id);
    // Whether or not batch 1 reached our row first, force the scenario explicitly:
    await prisma.outboxEvent.update({ where: { id }, data: { state: "processing", lockedBy: "worker-a", lockedAt: new Date() } });
    await prisma.outboxEvent.update({ where: { id }, data: { lockedBy: "worker-b" } }); // lease taken over
    await processOne(a, claimed ?? { id, topic: "email", payload: rfq("fence@example.test"), attempts: 1 });
    const ev = await get(id);
    expect(ev.state).toBe("processing");
    expect(ev.lockedBy).toBe("worker-b");
  });

  it("an operator can requeue a dead event, which then delivers", async () => {
    const id = await make(rfq("again@example.test"));
    await runOnce(deps(new FakeProvider(() => { throw new PermanentSendError("smtp 550"); })));
    expect((await get(id)).state).toBe("dead");
    expect(await requeueDead(prisma, id, new Date(0))).toBe(true);
    expect(await requeueDead(prisma, id)).toBe(false); // no longer dead
    await runOnce(deps(new FakeProvider()));
    expect((await get(id)).state).toBe("delivered");
  });

  it("reports the backlog by state", async () => {
    const b = await backlog(prisma);
    expect(b.delivered).toBeGreaterThan(0);
    expect(b.dead).toBeGreaterThan(0);
  });

  it("the database rejects a negative attempt count", async () => {
    const id = await make(rfq("chk@example.test"));
    await expect(prisma.$executeRaw`UPDATE "OutboxEvent" SET "attempts" = -1 WHERE "id" = ${id}`).rejects.toThrow();
  });
});

d("SMTP provider against a local SMTP server", () => {
  let server: SMTPServer; let port = 0;
  const received: Array<{ to: string; raw: string }> = [];
  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true, disabledCommands: ["STARTTLS"],
      onRcptTo(address, _s, cb) {
        if (address.address.startsWith("reject@")) return cb(Object.assign(new Error("5.1.1 no such user"), { responseCode: 550 }));
        if (address.address.startsWith("tempfail@")) return cb(Object.assign(new Error("4.2.1 try later"), { responseCode: 451 }));
        cb();
      },
      onData(stream, session, cb) { let raw = ""; stream.on("data", (c) => (raw += c)); stream.on("end", () => { received.push({ to: session.envelope.rcptTo[0]!.address, raw }); cb(); }); },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const mail = (to: string): OutgoingEmail => ({ to, subject: "Subject", text: "Body", html: "<p>Body</p>", idempotencyKey: uuid() });

  it("delivers, with a Message-ID and idempotency header derived from the outbox id", async () => {
    const p = new SmtpProvider({ url: `smtp://127.0.0.1:${port}`, from: "no-reply@example.test" });
    const m = mail("ok@example.test");
    const r = await p.send(m);
    expect(r.providerMessageId).toContain(m.idempotencyKey);
    const got = received.find((x) => x.raw.includes(m.idempotencyKey))!;
    expect(got.to).toBe("ok@example.test");
    expect(got.raw.toLowerCase()).toContain(`x-supplypiper-idempotency-key: ${m.idempotencyKey}`);
    p.close();
  });
  it("treats a 550 as permanent and a 451 as transient", async () => {
    const p = new SmtpProvider({ url: `smtp://127.0.0.1:${port}`, from: "no-reply@example.test" });
    await expect(p.send(mail("reject@example.test"))).rejects.toBeInstanceOf(PermanentSendError);
    await expect(p.send(mail("tempfail@example.test"))).rejects.toBeInstanceOf(TransientSendError);
    p.close();
  });
  it("treats a refused connection as transient", async () => {
    const p = new SmtpProvider({ url: "smtp://127.0.0.1:1", from: "no-reply@example.test" });
    await expect(p.send(mail("ok@example.test"))).rejects.toBeInstanceOf(TransientSendError);
    p.close();
  });
});

d("worker health endpoint", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>; let base = "";
  beforeAll(() => {
    const config = loadConfig({ SUPPLYPIPER_MODE: "demo", VERIFICATION_ADAPTER: "mock", DATABASE_URL: DB_URL });
    server = createApp({ config, prisma, checkReady: async () => true }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server?.close(); });

  it("reports a stale or missing worker as unhealthy, and a fresh heartbeat as healthy, with counts only", async () => {
    await prisma.workerHeartbeat.deleteMany({ where: { name: "email-outbox" } });
    const none = await fetch(`${base}/health/worker`);
    expect(none.status).toBe(503);
    expect(((await none.json()) as { status: string }).status).toBe("no_worker_seen");
    await heartbeat(prisma, "email-outbox", new Date(Date.now() - 3_600_000), { processed: 1, failed: 0 }, new Date(Date.now() - 120_000));
    const stale = await fetch(`${base}/health/worker`);
    expect(stale.status).toBe(503);
    expect(((await stale.json()) as { status: string }).status).toBe("stale");
    await heartbeat(prisma, "email-outbox", new Date(), { processed: 0, failed: 0 });
    const ok = await fetch(`${base}/health/worker`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string; queue: Record<string, number> };
    expect(body.status).toBe("ok");
    expect(Object.keys(body.queue).sort()).toEqual(["dead", "failed", "pending", "processing"]);
    expect(JSON.stringify(body)).not.toMatch(/@|token/);
  });
});
