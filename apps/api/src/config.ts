export type AppMode = "demo" | "testnet" | "production";
export type AdapterKind = "mock" | "real";

export interface AiConfig {
  provider: "none" | "anthropic";
  /** Server-only. Never sent to the browser, logged, or stored. */
  apiKey?: string;
  model: string; effort: "low" | "medium" | "high";
  /** Integer micro-USD per million tokens. Defaults are Anthropic's published rates for claude-opus-5-5 as cached in the API skill on 2026-11-03: verify before relying on cost figures. */
  pricing: { inputMicroUsdPerMTok: number; outputMicroUsdPerMTok: number };
  costLimitMicroUsd: number; maxToolCalls: number; maxTurns: number; timeoutMs: number; maxOutputTokensPerCall: number;
  refusalFallback: boolean; runsPerUserPerHour: number;
}

export interface AppConfig {
  mode: AppMode;
  port: number;
  databaseUrl: string;
  verificationAdapter: AdapterKind;
  paymentAdapter: AdapterKind | "disabled";
  verificationFreshnessMs: number;
  seededCredentials: boolean;
  /** Local-only mail inbox for development. Never allowed in production. */
  devInbox: boolean;
  ai: AiConfig;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const problems: string[] = [];
  const mode = env.SUPPLYPIPER_MODE as AppMode | undefined;
  if (mode !== "demo" && mode !== "testnet" && mode !== "production") {
    problems.push("SUPPLYPIPER_MODE must be one of demo | testnet | production");
  }
  const verificationAdapter: AdapterKind = env.VERIFICATION_ADAPTER === "mock" ? "mock" : "real";
  const paymentAdapter = (env.PAYMENT_ADAPTER ?? "disabled") as AppConfig["paymentAdapter"];
  const seededCredentials = env.SEEDED_CREDENTIALS === "true";
  const devInbox = env.DEV_INBOX === "true";
  const int = (name: string, dflt: number, min: number, max: number): number => {
    const raw = env[name]; const n = raw === undefined || raw === "" ? dflt : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${name} must be an integer from ${min} to ${max}`); return dflt; }
    return n;
  };
  const aiProvider = (env.AI_PROVIDER ?? "none") as AiConfig["provider"];
  if (aiProvider !== "none" && aiProvider !== "anthropic") problems.push("AI_PROVIDER must be none or anthropic");
  if (aiProvider === "anthropic" && !env.ANTHROPIC_API_KEY) problems.push("AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY (server-side only)");
  const effort = (env.AI_EFFORT ?? "low") as AiConfig["effort"];
  if (!["low", "medium", "high"].includes(effort)) problems.push("AI_EFFORT must be low, medium or high");
  const ai: AiConfig = {
    provider: aiProvider === "anthropic" ? "anthropic" : "none", apiKey: env.ANTHROPIC_API_KEY || undefined, model: env.AI_MODEL || "claude-opus-5-5", effort,
    pricing: { inputMicroUsdPerMTok: int("AI_INPUT_MICROUSD_PER_MTOK", 4_000_000, 1, 1_000_000_000), outputMicroUsdPerMTok: int("AI_OUTPUT_MICROUSD_PER_MTOK", 20_000_000, 1, 1_000_000_000) },
    costLimitMicroUsd: int("AI_RUN_COST_LIMIT_MICROUSD", 100_000, 1_000, 50_000_000), maxToolCalls: int("AI_MAX_TOOL_CALLS", 6, 1, 20), maxTurns: int("AI_MAX_TURNS", 5, 1, 12),
    timeoutMs: int("AI_RUN_TIMEOUT_MS", 60_000, 5_000, 300_000), maxOutputTokensPerCall: int("AI_MAX_OUTPUT_TOKENS", 3_000, 256, 16_000),
    refusalFallback: env.AI_REFUSAL_FALLBACK === "true", runsPerUserPerHour: int("AI_RUNS_PER_USER_PER_HOUR", 30, 1, 1000),
  };
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) problems.push("DATABASE_URL is required");
  const freshness = Number(env.VERIFICATION_FRESHNESS_SECONDS ?? "300");
  if (!Number.isInteger(freshness) || freshness <= 0) problems.push("VERIFICATION_FRESHNESS_SECONDS must be a positive integer");

  if (mode === "production") {
    if (verificationAdapter === "mock") problems.push("production must not use the mock verification adapter");
    if (paymentAdapter === "mock") problems.push("production must not use the mock payment adapter");
    if (seededCredentials) problems.push("production must not contain seeded credentials");
    if (devInbox) problems.push("production must not expose the development inbox");
    if (/localhost|127\.0\.0\.1/.test(databaseUrl)) problems.push("production must not point at a local database");
  }
  if (mode !== "demo" && verificationAdapter === "mock") {
    problems.push("the mock verification adapter is only allowed in demo mode");
  }
  if (problems.length) throw new ConfigError(problems);
  return {
    mode: mode!, port: Number(env.PORT ?? "4000"), databaseUrl, verificationAdapter, paymentAdapter,
    verificationFreshnessMs: freshness * 1000, seededCredentials, devInbox, ai,
  };
}
