import dns from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import { isPrivateOrReservedIp, MAX_CARD_BYTES, screenCardUrl } from "./card";

export type CardFetchResult =
  | { kind: "ok"; status: number; bytes: Uint8Array }
  | { kind: "rejected"; reason: string }
  /** transient = worth retrying later (network/timeout/5xx); otherwise the host answered and the card is simply not there. */
  | { kind: "failed"; transient: boolean; status?: number; detail: string };

export interface CardFetcher { fetch(url: string): Promise<CardFetchResult> }

type LookupFn = (hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => void;

/**
 * DNS lookup that refuses private/reserved targets. It runs at CONNECT time on the address that will actually be used,
 * so a hostname that resolves publicly during a pre-check and privately at connect (DNS rebinding) cannot slip through.
 */
export function guardedLookup(base: (host: string, opts: dns.LookupAllOptions, cb: (e: NodeJS.ErrnoException | null, a: dns.LookupAddress[]) => void) => void = dns.lookup as never): LookupFn {
  return (hostname, options, cb) => {
    base(hostname, { all: true, ...(options as object) } as dns.LookupAllOptions, (err, addrs) => {
      if (err) return cb(err, "", 0);
      const list = addrs ?? [];
      if (list.length === 0 || list.some((a) => isPrivateOrReservedIp(a.address))) {
        const e = new Error("target resolves to a private or reserved address") as NodeJS.ErrnoException;
        e.code = "PRIVATE_ADDRESS";
        return cb(e, "", 0);
      }
      if ((options as { all?: boolean }).all) cb(null, list);
      else cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface HardenedFetcherOptions { timeoutMs?: number; maxBytes?: number; lookup?: LookupFn }

/** https only, no credentials, no redirects, response size and time capped, private addresses refused at connect time. */
export function createHardenedCardFetcher(opts: HardenedFetcherOptions = {}): CardFetcher {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? MAX_CARD_BYTES;
  const lookup = opts.lookup ?? guardedLookup();
  return {
    fetch(rawUrl) {
      const verdict = screenCardUrl(rawUrl);
      if (!verdict.ok) return Promise.resolve({ kind: "rejected", reason: verdict.reason });
      const url = verdict.url;
      if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return Promise.resolve({ kind: "rejected", reason: "IP-literal hosts are not fetched" });
      return new Promise<CardFetchResult>((resolve) => {
        let settled = false;
        const done = (r: CardFetchResult) => { if (!settled) { settled = true; resolve(r); } };
        const req = https.request(url, { method: "GET", lookup: lookup as never, agent: false, timeout: timeoutMs, headers: { accept: "application/json", "user-agent": "SupplyPiper-AgentCardCheck/0.1" } }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) { res.resume(); return done({ kind: "rejected", reason: "redirects are not followed" }); }
          const declared = Number(res.headers["content-length"] ?? 0);
          if (declared > maxBytes) { res.destroy(); return done({ kind: "rejected", reason: "response too large" }); }
          const chunks: Buffer[] = []; let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) { res.destroy(); done({ kind: "rejected", reason: "response too large" }); return; }
            chunks.push(c);
          });
          res.on("end", () => {
            if (status === 200) return done({ kind: "ok", status, bytes: new Uint8Array(Buffer.concat(chunks)) });
            done({ kind: "failed", transient: status >= 500 || status === 429 || status === 408, status, detail: `card host answered HTTP ${status}` });
          });
          res.on("error", (e) => done({ kind: "failed", transient: true, detail: e.message }));
        });
        req.on("timeout", () => { req.destroy(); done({ kind: "failed", transient: true, detail: "timed out" }); });
        req.on("error", (e: NodeJS.ErrnoException) => {
          if (e.code === "PRIVATE_ADDRESS") return done({ kind: "rejected", reason: e.message });
          done({ kind: "failed", transient: true, detail: e.code ?? e.message });
        });
        req.end();
      });
    },
  };
}
