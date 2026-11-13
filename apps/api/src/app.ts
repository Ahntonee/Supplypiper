import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import express, { type ErrorRequestHandler, type Express } from "express";
import { authRouter, requestGuards, sessionLoader } from "./auth";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { agentsRouter } from "./agents";
import { assistantRouter, type AssistantService } from "./assistant";
import { quoteAgentRouter } from "./quoteAgent";
import type { VerificationService } from "./agentVerification";
import type { AccountInfoProvider } from "@supplypiper/concordium";
import { catalogueRouter } from "./catalogue";
import { orgRouter } from "./orgs";
import { notificationsRouter } from "./notifications";
import { ordersRouter } from "./orders";
import { requestsRouter } from "./requests";

export { ApiError };

export interface AppDeps {
  config: AppConfig;
  /** Readiness probe, e.g. a `SELECT 1`. Must never throw secrets. */
  checkReady: () => Promise<boolean>;
  /** Without a database only health/readiness/environment routes are mounted. */
  prisma?: PrismaClient;
  allowedOrigins?: string[];
  /** Agent identity checks. Absent means agent quotes cannot be verified (and so cannot qualify for the verified lane). */
  verification?: VerificationService;
  /** Reads account keys from the chain to verify wallet ownership proofs. */
  accountProvider?: AccountInfoProvider;
  /** Audience string bound into ownership challenges. */
  audience?: string;
  /** Optional AI assistant. Absent or unavailable means every AI feature reports "unavailable" and the manual product is unaffected. */
  assistant?: AssistantService;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.use((req, res, next) => {
    const incoming = req.header("x-correlation-id");
    const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.correlationId = id;
    res.setHeader("x-correlation-id", id);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  /** Operational status of the email worker: last heartbeat and queue depth. Counts only; no addresses or message content. */
  if (deps.prisma) {
    const prisma = deps.prisma;
    app.get("/health/worker", async (_req, res) => {
      const [beat, rows, oldest] = await Promise.all([
        prisma.workerHeartbeat.findUnique({ where: { name: "email-outbox" } }),
        prisma.outboxEvent.groupBy({ by: ["state"], _count: true }),
        prisma.outboxEvent.findFirst({ where: { state: { in: ["pending", "failed"] } }, orderBy: { nextAttemptAt: "asc" }, select: { nextAttemptAt: true } }),
      ]);
      const n = (s: string) => rows.find((r) => r.state === s)?._count ?? 0;
      const ageSec = beat ? Math.round((Date.now() - beat.lastBeatAt.getTime()) / 1000) : null;
      const alive = ageSec !== null && ageSec < 30;
      const lagSec = oldest ? Math.max(0, Math.round((Date.now() - oldest.nextAttemptAt.getTime()) / 1000)) : 0;
      res.status(alive ? 200 : 503).json({ status: alive ? "ok" : beat ? "stale" : "no_worker_seen", lastBeatSecondsAgo: ageSec, queue: { pending: n("pending"), processing: n("processing"), failed: n("failed"), dead: n("dead") }, oldestDueSecondsAgo: lagSec });
    });
  }

  app.get("/ready", async (_req, res) => {
    let ready = false;
    try { ready = await deps.checkReady(); } catch { ready = false; }
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });

  /** Public, non-sensitive description of the running mode so the UI can show the right banner. */
  app.get("/api/v1/environment", (_req, res) => {
    const m = deps.config.mode;
    res.json({
      mode: m,
      banner: m === "demo" ? "Demo — sample data; verification and payments may be simulated." :
        m === "testnet" ? "Testnet pilot — test tokens only; test tokens have no real purchase value." : null,
      verificationAdapter: deps.config.verificationAdapter,
      paymentsEnabled: deps.config.paymentAdapter !== "disabled",
      devInbox: deps.config.devInbox,
      aiAvailable: !!deps.assistant?.available,
      verificationFreshnessSeconds: deps.config.verificationFreshnessMs / 1000,
    });
  });

  if (deps.prisma && deps.config.devInbox) {
    const prisma = deps.prisma;
    /** Development only: shows queued emails so accounts can be verified without a mail provider. Loopback callers only. */
    app.get("/api/v1/dev/inbox", async (req, res) => {
      const ip = req.socket.remoteAddress ?? "";
      if (!/^(::1|127.0.0.1|::ffff:127.0.0.1)$/.test(ip)) throw new ApiError(404, "NOT_FOUND", "No such route");
      const to = typeof req.query.to === "string" ? req.query.to.toLowerCase() : undefined;
      const rows = await prisma.outboxEvent.findMany({ where: { topic: "email", ...(to ? { payload: { path: ["to"], equals: to } } : {}) }, orderBy: { createdAt: "desc" }, take: 25, include: { sentEmail: true } });
      // Raw queue entries plus delivery state. "rendered" is present only once the worker has delivered the message to the dev inbox.
      res.json({ emails: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, state: r.state, attempts: r.attempts, lastError: r.lastError, rendered: r.sentEmail ? { subject: r.sentEmail.subject, text: r.sentEmail.text } : null, ...(r.payload as object) })) });
    });
  }

  if (deps.prisma) {
    app.use("/api/v1", requestGuards(deps.config, deps.allowedOrigins ?? []), sessionLoader(deps.prisma));
    app.use("/api/v1/auth", authRouter(deps.prisma, deps.config));
    app.use("/api/v1", orgRouter(deps.prisma, deps.config));
    app.use("/api/v1", catalogueRouter(deps.prisma, deps.config));
    app.use("/api/v1", agentsRouter(deps.prisma, deps.config, { verification: deps.verification, accountProvider: deps.accountProvider, audience: deps.audience ?? "supplypiper" }));
    app.use("/api/v1", requestsRouter(deps.prisma, deps.config, deps.verification, deps.assistant));
    if (deps.assistant) app.use("/api/v1", assistantRouter(deps.prisma, deps.config, deps.assistant));
    app.use("/api/v1", quoteAgentRouter(deps.prisma));
    app.use("/api/v1", ordersRouter(deps.prisma));
    app.use("/api/v1", notificationsRouter(deps.prisma));
  }

  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "No such route")));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const correlationId = res.locals.correlationId as string;
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details ?? {}, correlationId } });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON", details: {}, correlationId } });
      return;
    }
    console.error(JSON.stringify({ level: "error", correlationId, message: String(err?.message ?? err) }));
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong. Quote the correlation ID to support.", details: {}, correlationId } });
  };
  app.use(onError);
  return app;
}
