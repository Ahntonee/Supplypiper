import { hostname } from "node:os";
import { PrismaClient } from "@prisma/client";
import { loadWorkerConfig } from "./config";
import { heartbeat, runOnce, type DeliverDeps } from "./deliver";
import { DevInboxProvider, SmtpProvider, type EmailProvider } from "./providers";

const config = loadWorkerConfig(process.env);
const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
const workerId = `${hostname()}-${process.pid}`;
const provider: EmailProvider = config.emailMode === "smtp" ? new SmtpProvider({ url: config.smtpUrl!, from: config.from! }) : new DevInboxProvider(prisma);
const deps: DeliverDeps = {
  prisma, provider, workerId, render: { baseUrl: config.baseUrl, modeLabel: config.modeLabel },
  batch: config.batch, leaseMs: config.leaseMs, maxAttempts: config.maxAttempts, allowedDomains: config.allowedDomains,
};

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), worker: workerId, ...o })); // never logs payloads
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { log({ level: "info", msg: "stopping after the current batch", sig }); stopping = true; });

const startedAt = new Date();
log({ level: "info", msg: "worker started", mode: config.mode, email: config.emailMode, provider: provider.name, recipientsRestricted: !!config.allowedDomains });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

while (!stopping) {
  try {
    const r = await runOnce(deps);
    await heartbeat(prisma, "email-outbox", startedAt, { processed: r.delivered + r.dead, failed: r.failed });
    if (r.claimed > 0) log({ level: r.failed + r.dead > 0 ? "warn" : "info", msg: "batch", ...r });
    if (r.claimed === 0) await sleep(config.pollMs);
  } catch (e) {
    log({ level: "error", msg: "batch crashed; will retry", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    await sleep(Math.max(config.pollMs, 5000));
  }
}
if (provider instanceof SmtpProvider) provider.close();
await prisma.$disconnect();
log({ level: "info", msg: "worker stopped" });
