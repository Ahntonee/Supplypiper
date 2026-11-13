export type EmailMode = "dev" | "smtp";
export type AppMode = "demo" | "testnet" | "production";

export interface WorkerConfig {
  mode: AppMode; databaseUrl: string; emailMode: EmailMode; from: string | null; smtpUrl: string | null;
  /** null = any recipient. Required in smtp mode outside production so a pilot cannot email real people by accident. */
  allowedDomains: string[] | null; baseUrl: string; modeLabel: string;
  pollMs: number; batch: number; leaseMs: number; maxAttempts: number;
}

export class WorkerConfigError extends Error {
  constructor(public readonly problems: string[]) { super(`Invalid worker configuration:\n- ${problems.join("\n- ")}`); this.name = "WorkerConfigError"; }
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const problems: string[] = [];
  const mode = env.SUPPLYPIPER_MODE as AppMode | undefined;
  if (mode !== "demo" && mode !== "testnet" && mode !== "production") problems.push("SUPPLYPIPER_MODE must be one of demo | testnet | production");
  const emailMode = (env.EMAIL_MODE ?? "dev") as EmailMode;
  if (emailMode !== "dev" && emailMode !== "smtp") problems.push("EMAIL_MODE must be dev or smtp");
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) problems.push("DATABASE_URL is required");
  const int = (name: string, dflt: number, min: number, max: number) => {
    const raw = env[name]; const n = raw === undefined || raw === "" ? dflt : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${name} must be an integer from ${min} to ${max}`); return dflt; }
    return n;
  };
  const allowed = (env.EMAIL_ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const baseUrl = (env.PUBLIC_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
  try { new URL(baseUrl); } catch { problems.push("PUBLIC_BASE_URL must be a valid URL"); }

  if (mode === "production" && emailMode === "dev") problems.push("production must not use the development email inbox");
  if (emailMode === "smtp") {
    if (!env.SMTP_URL) problems.push("EMAIL_MODE=smtp needs SMTP_URL");
    if (!env.EMAIL_FROM || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.EMAIL_FROM)) problems.push("EMAIL_MODE=smtp needs a valid EMAIL_FROM");
    // Live notifications need an explicit operator decision, and outside production a configured recipient list.
    if (env.EMAIL_LIVE_APPROVED !== "true") problems.push("live email needs the operator's explicit approval: set EMAIL_LIVE_APPROVED=true");
    if (mode !== "production" && allowed.length === 0) problems.push("outside production, live email needs EMAIL_ALLOWED_DOMAINS (the pilot recipients' domains)");
  }
  const pollMs = int("WORKER_POLL_MS", 2000, 100, 60_000), batch = int("WORKER_BATCH", 10, 1, 200), leaseMs = int("WORKER_LEASE_MS", 120_000, 5_000, 3_600_000), maxAttempts = int("WORKER_MAX_ATTEMPTS", 8, 1, 50);
  if (problems.length) throw new WorkerConfigError(problems);
  return {
    mode: mode!, databaseUrl, emailMode, from: env.EMAIL_FROM || null, smtpUrl: env.SMTP_URL || null, allowedDomains: allowed.length ? allowed : null, baseUrl,
    modeLabel: mode === "demo" ? "[Demo] " : mode === "testnet" ? "[Testnet] " : "",
    pollMs, batch, leaseMs, maxAttempts,
  };
}
