import { describe, expect, it } from "vitest";
import { cardHashMatches, isFresh, isPrivateOrReservedIp, screenCardUrl, sha256Hex, NotImplementedVerifier, DemoVerifier } from "./index";

describe("card URL SSRF screen", () => {
  it.each([
    "http://example.com/card.json", "https://127.0.0.1/c", "https://10.0.0.5/c", "https://169.254.169.254/latest",
    "https://[::1]/c", "https://localhost/c", "https://user:pw@example.com/c", "https://example.com:8443/c",
    "https://intranet/c", "https://[fd00::1]/c", "https://[::ffff:192.168.1.1]/c", "not a url",
  ])("rejects %s", (u) => expect(screenCardUrl(u).ok).toBe(false));
  it("accepts a normal public https URL", () => expect(screenCardUrl("https://agents.example.com/card.json").ok).toBe(true));
  it("classifies private ranges", () => {
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
  });
});

describe("card hash", () => {
  const bytes = new TextEncoder().encode('{"name":"x"}');
  it("matches exact served bytes and rejects any change", () => {
    expect(cardHashMatches(bytes, sha256Hex(bytes))).toBe(true);
    expect(cardHashMatches(new TextEncoder().encode('{"name":"y"}'), sha256Hex(bytes))).toBe(false);
    expect(cardHashMatches(bytes, "zz")).toBe(false);
  });
  it("rejects oversized responses", () => {
    expect(cardHashMatches(new Uint8Array(300_000), sha256Hex(new Uint8Array(300_000)))).toBe(false);
  });
});

describe("freshness and adapters", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  it("five-minute policy boundary", () => {
    expect(isFresh(new Date(now.getTime() - 300_000), now, 300_000)).toBe(true);
    expect(isFresh(new Date(now.getTime() - 300_001), now, 300_000)).toBe(false);
    expect(isFresh(new Date(now.getTime() + 1000), now, 300_000)).toBe(false);
  });
  it("placeholder verifier never reports verified", async () => {
    const r = await new NotImplementedVerifier().verify({ network: "testnet" });
    expect(r.status).toBe("unavailable");
  });
  it("demo verifier is always labelled simulated", async () => {
    const r = await new DemoVerifier().verify();
    expect(r.simulated).toBe(true);
    expect(r.network).toBe("demo");
  });
});
