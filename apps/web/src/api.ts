/** Thin same-origin client. The session lives in an HttpOnly cookie; only the CSRF token is held in memory. */
let csrfToken = "";
export const setCsrf = (t: string) => { csrfToken = t; };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, string> = {}, public correlationId = "") {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method, credentials: "same-origin",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "You appear to be offline or the server is unreachable. Your input is kept; try again.");
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? "UNKNOWN", e?.message ?? "Something went wrong", e?.details ?? {}, e?.correlationId ?? "");
  }
  return json as T;
}

export interface Me { csrfToken: string; user: { id: string; email: string; displayName: string; timezone: string } }
export interface OrgSummary { id: string; name: string; capabilities: ("buyer" | "supplier")[]; roles: string[] }
export interface EnvInfo { verificationAdapter: "mock" | "real"; mode: "demo" | "testnet" | "production"; banner: string | null; devInbox: boolean; paymentsEnabled: boolean; verificationFreshnessSeconds: number }
