import { describe, expect, it } from "vitest";
import { loadWorkerConfig, WorkerConfigError } from "./config";
import { backoffMs, sanitizeError } from "./deliver";
import { NOTIFIABLE, renderEmail, UnrenderableError } from "./templates";

const ctx = { baseUrl: "https://app.example.test", modeLabel: "[Demo] " };
const uuid = "3f1c1b2e-6f0a-4a43-9a52-2f6d0f6a9b11";

describe("templates", () => {
  it("renders every template with a link on the configured base URL and the environment label", () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ["verify_email", { token: "abcdefghij1234567890" }, "/verify?token=abcdefghij1234567890"],
      ["password_reset", { token: "abcdefghij1234567890" }, "/reset-password?token="],
      ["org_invitation", { token: "abcdefghij1234567890" }, "/accept-invite?token="],
      ["rfq_invited", { requestId: uuid }, `/app/inbox/${uuid}`],
      ["order_created", { orderId: uuid }, `/app/orders/${uuid}`],
      ["order_accepted", { orderId: uuid }, `/app/orders/${uuid}`],
    ];
    for (const [t, data, path] of cases) {
      const m = renderEmail(t, data, ctx);
      expect(m.subject.startsWith("[Demo] ")).toBe(true);
      expect(m.text).toContain(`https://app.example.test${path}`);
      expect(m.html).toContain("not from a production service");
    }
  });
  it("adds no environment label in production", () => {
    expect(renderEmail("rfq_invited", { requestId: uuid }, { baseUrl: ctx.baseUrl, modeLabel: "" }).subject).not.toMatch(/^\[/);
  });
  it("rejects unknown templates and malformed or extra data instead of guessing", () => {
    expect(() => renderEmail("nope", {}, ctx)).toThrow(UnrenderableError);
    expect(() => renderEmail("rfq_invited", { requestId: "not-a-uuid" }, ctx)).toThrow(UnrenderableError);
    expect(() => renderEmail("order_created", { orderId: uuid, price: "100" }, ctx)).toThrow(UnrenderableError);
    expect(() => renderEmail("verify_email", { token: "short" }, ctx)).toThrow(UnrenderableError);
  });
  it("never puts a single-use token in an in-app notification", () => {
    expect([...NOTIFIABLE].sort()).toEqual(["order_accepted", "order_created", "rfq_invited"]);
  });
  it("escapes HTML in the output", () => {
    const m = renderEmail("rfq_invited", { requestId: uuid }, { baseUrl: "https://a.test", modeLabel: "[<b>x</b>] " });
    expect(m.html).not.toContain("<b>x</b>");
  });
});

describe("retry schedule", () => {
  it("doubles from 30 s, caps at one hour, and jitters within 20%", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(3, mid)).toBe(120_000);
    expect(backoffMs(30, mid)).toBe(3_600_000);
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 0.999999)).toBeLessThanOrEqual(36_000);
  });
});

describe("stored error text", () => {
  it("redacts tokens and email addresses and is bounded", () => {
    const s = sanitizeError(new Error("550 user a.b@example.com token abcdefghijklmnopqrstuvwxyz0123456789 failed"));
    expect(s).not.toContain("a.b@example.com");
    expect(s).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(sanitizeError(new Error("x".repeat(5000))).length).toBeLessThanOrEqual(200);
  });
});

describe("worker configuration guards", () => {
  const base = { SUPPLYPIPER_MODE: "demo", DATABASE_URL: "postgresql://x" };
  it("defaults to the development inbox and a mode label", () => {
    const c = loadWorkerConfig(base);
    expect(c.emailMode).toBe("dev");
    expect(c.modeLabel).toBe("[Demo] ");
  });
  it("refuses the development inbox in production", () => {
    expect(() => loadWorkerConfig({ ...base, SUPPLYPIPER_MODE: "production" })).toThrow(/production must not use the development email inbox/);
  });
  it("refuses live email without explicit approval, sender and recipient allow-list", () => {
    try { loadWorkerConfig({ ...base, EMAIL_MODE: "smtp" }); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(WorkerConfigError);
      const m = (e as Error).message;
      expect(m).toMatch(/SMTP_URL/); expect(m).toMatch(/EMAIL_FROM/); expect(m).toMatch(/EMAIL_LIVE_APPROVED/); expect(m).toMatch(/EMAIL_ALLOWED_DOMAINS/);
    }
  });
  it("accepts a fully specified, approved live configuration", () => {
    const c = loadWorkerConfig({ ...base, EMAIL_MODE: "smtp", SMTP_URL: "smtp://localhost:2525", EMAIL_FROM: "no-reply@example.test", EMAIL_LIVE_APPROVED: "true", EMAIL_ALLOWED_DOMAINS: "Example.test, pilot.test" });
    expect(c.allowedDomains).toEqual(["example.test", "pilot.test"]);
  });
  it("rejects out-of-range numeric settings", () => {
    expect(() => loadWorkerConfig({ ...base, WORKER_BATCH: "0" })).toThrow(/WORKER_BATCH/);
  });
});
