import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import express, { type ErrorRequestHandler, type Express } from "express";
import { authRouter, requestGuards, sessionLoader } from "./auth";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { orgRouter } from "./orgs";

export { ApiError };

export interface AppDeps {
  config: AppConfig;
  /** Readiness probe, e.g. a `SELECT 1`. Must never throw secrets. */
  checkReady: () => Promise<boolean>;
  /** Without a database only health/readiness/environment routes are mounted. */
  prisma?: PrismaClient;
  allowedOrigins?: string[];
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
      verificationFreshnessSeconds: deps.config.verificationFreshnessMs / 1000,
    });
  });

  if (deps.prisma) {
    app.use("/api/v1", requestGuards(deps.config, deps.allowedOrigins ?? []), sessionLoader(deps.prisma));
    app.use("/api/v1/auth", authRouter(deps.prisma, deps.config));
    app.use("/api/v1", orgRouter(deps.prisma, deps.config));
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
