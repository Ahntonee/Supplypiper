import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";

const base = { DATABASE_URL: "postgresql://u:p@db.internal:5432/x" };

describe("config guards", () => {
  it("rejects production with mock verification, seeded credentials or local DB", () => {
    expect(() => loadConfig({ ...base, SUPPLYPIPER_MODE: "production", VERIFICATION_ADAPTER: "mock" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SUPPLYPIPER_MODE: "production", SEEDED_CREDENTIALS: "true" })).toThrow(/seeded/);
    expect(() => loadConfig({ DATABASE_URL: "postgresql://u:p@localhost/x", SUPPLYPIPER_MODE: "production" })).toThrow(/local database/);
  });
  it("never allows the development inbox in production", () => {
    expect(() => loadConfig({ ...base, SUPPLYPIPER_MODE: "production", DEV_INBOX: "true" })).toThrow(/development inbox/);
    expect(loadConfig({ ...base, SUPPLYPIPER_MODE: "demo", VERIFICATION_ADAPTER: "mock" }).devInbox).toBe(false); // off by default
  });
  it("allows mock verification only in demo", () => {
    expect(loadConfig({ ...base, SUPPLYPIPER_MODE: "demo", VERIFICATION_ADAPTER: "mock" }).verificationAdapter).toBe("mock");
    expect(() => loadConfig({ ...base, SUPPLYPIPER_MODE: "testnet", VERIFICATION_ADAPTER: "mock" })).toThrow(/demo mode/);
  });
  it("requires a valid mode and database", () => {
    expect(() => loadConfig({})).toThrow(/SUPPLYPIPER_MODE/);
  });
});

describe("http", () => {
  const config = loadConfig({ ...base, SUPPLYPIPER_MODE: "demo", VERIFICATION_ADAPTER: "mock" });
  let ready = true;
  const server = createApp({ config, checkReady: async () => ready }).listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => { server.close(); });

  it("reports health, readiness, and demo banner", async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/ready`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${url}/ready`)).status).toBe(503);
    const env = (await (await fetch(`${url}/api/v1/environment`)).json()) as { banner: string; paymentsEnabled: boolean };
    expect(env.banner).toMatch(/^Demo/);
    expect(env.paymentsEnabled).toBe(false);
  });
  it("returns structured errors with a correlation id and no stack", async () => {
    const res = await fetch(`${url}/nope`);
    const body = (await res.json()) as { error: { code: string; correlationId: string } };
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.correlationId).toBe(res.headers.get("x-correlation-id"));
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts/);
  });
  it("rejects malformed JSON safely", async () => {
    const res = await fetch(`${url}/api/v1/environment`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
    expect([400, 404]).toContain(res.status);
  });
});
