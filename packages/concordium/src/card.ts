import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const MAX_CARD_BYTES = 256 * 1024;

export type CardUrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

export function isPrivateOrReservedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) {
      const rest = l.slice(7);
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest); // URL parser normalises to hex form
      if (hex) {
        const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
        return isPrivateOrReservedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
      return isPrivateOrReservedIp(rest);
    }
    if (l.startsWith("64:ff9b:")) return true; // NAT64: treat as reserved, never resolve internal targets via it
    return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("ff");
  }
  return false;
}

/** Static URL screen. The fetcher must ALSO check every resolved address and never auto-follow redirects. */
export function screenCardUrl(raw: string): CardUrlVerdict {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "not a valid URL" }; }
  if (url.protocol !== "https:") return { ok: false, reason: "https only" };
  if (url.username || url.password) return { ok: false, reason: "credentials in URL" };
  if (url.port && url.port !== "443") return { ok: false, reason: "non-standard port" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) && isPrivateOrReservedIp(host)) return { ok: false, reason: "private or reserved address" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "local hostname" };
  }
  if (!host.includes(".") && !isIP(host)) return { ok: false, reason: "single-label hostname" };
  return { ok: true, url };
}

/** SHA-256 over the exact bytes served (the documented integration-guide method). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function cardHashMatches(servedBytes: Uint8Array, onChainHashHex: string): boolean {
  if (servedBytes.byteLength > MAX_CARD_BYTES) return false;
  const a = Buffer.from(sha256Hex(servedBytes), "hex");
  const clean = onChainHashHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) return false;
  return timingSafeEqual(a, Buffer.from(clean, "hex"));
}

/** Freshness is OUR application policy, not a Concordium guarantee. */
export function isFresh(checkedAt: Date, now: Date, freshnessMs: number): boolean {
  const age = now.getTime() - checkedAt.getTime();
  return age >= 0 && age <= freshnessMs;
}
