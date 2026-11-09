export type AppMode = "demo" | "testnet" | "production";
export type AdapterKind = "mock" | "real";

export interface AppConfig {
  mode: AppMode;
  port: number;
  databaseUrl: string;
  verificationAdapter: AdapterKind;
  paymentAdapter: AdapterKind | "disabled";
  verificationFreshnessMs: number;
  seededCredentials: boolean;
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
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) problems.push("DATABASE_URL is required");
  const freshness = Number(env.VERIFICATION_FRESHNESS_SECONDS ?? "300");
  if (!Number.isInteger(freshness) || freshness <= 0) problems.push("VERIFICATION_FRESHNESS_SECONDS must be a positive integer");

  if (mode === "production") {
    if (verificationAdapter === "mock") problems.push("production must not use the mock verification adapter");
    if (paymentAdapter === "mock") problems.push("production must not use the mock payment adapter");
    if (seededCredentials) problems.push("production must not contain seeded credentials");
    if (/localhost|127\.0\.0\.1/.test(databaseUrl)) problems.push("production must not point at a local database");
  }
  if (mode !== "demo" && verificationAdapter === "mock") {
    problems.push("the mock verification adapter is only allowed in demo mode");
  }
  if (problems.length) throw new ConfigError(problems);
  return {
    mode: mode!, port: Number(env.PORT ?? "4000"), databaseUrl, verificationAdapter, paymentAdapter,
    verificationFreshnessMs: freshness * 1000, seededCredentials,
  };
}
