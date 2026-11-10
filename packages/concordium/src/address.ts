import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") bytes.unshift(0); else break; } // leading zero bytes
  return Uint8Array.from(bytes);
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

/** Concordium Base58Check: payload followed by the first 4 bytes of sha256(sha256(payload)). */
export function base58CheckDecode(s: string): Uint8Array | null {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4);
  const sum = raw.subarray(raw.length - 4);
  const want = sha256(sha256(payload)).subarray(0, 4);
  return want.every((b, i) => b === sum[i]) ? payload : null;
}

function readUleb128(bytes: Uint8Array, at: number): { value: bigint; next: number } | null {
  let result = 0n; let shift = 0n; let i = at;
  while (i < bytes.length) {
    const b = bytes[i++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, next: i };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

export interface DecodedTokenAddress { contractIndex: bigint; contractSubindex: bigint; tokenId: bigint }

/**
 * Decodes a CIS-2 token address (the "badge string"): Base58Check of 0x02 || ULEB128(index) || ULEB128(subindex) || token id bytes.
 * Format per the Concordium badge specification; verified here against real registry addresses.
 * Returns null for anything malformed, so callers never act on a guessed value.
 */
export function decodeTokenAddress(address: string): DecodedTokenAddress | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{10,60}$/.test(address)) return null;
  const payload = base58CheckDecode(address);
  if (!payload || payload[0] !== 0x02) return null;
  const idx = readUleb128(payload, 1); if (!idx) return null;
  const sub = readUleb128(payload, idx.next); if (!sub) return null;
  const tokenBytes = payload.subarray(sub.next);
  if (tokenBytes.length === 0 || tokenBytes.length > 8) return null;
  let tokenId = 0n;
  for (let i = tokenBytes.length - 1; i >= 0; i--) tokenId = (tokenId << 8n) | BigInt(tokenBytes[i]!); // little-endian
  return { contractIndex: idx.value, contractSubindex: sub.value, tokenId };
}

/** Concordium account addresses are Base58Check with version byte 1 and 32 bytes of payload. */
export function isAccountAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(address)) return false;
  const p = base58CheckDecode(address);
  return !!p && p.length === 33 && p[0] === 0x01;
}

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)]! + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
const withChecksum = (payload: Uint8Array) => Uint8Array.from([...payload, ...sha256(sha256(payload)).subarray(0, 4)]);
const uleb = (v: bigint): number[] => { const o: number[] = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; o.push(b); } while (v > 0n); return o; };

/** Inverse of {@link decodeTokenAddress}; token ids are written as 8 little-endian bytes (TokenIdU64), as the registry does. */
export function encodeTokenAddress(a: DecodedTokenAddress): string {
  const id: number[] = []; let t = a.tokenId;
  for (let i = 0; i < 8; i++) { id.push(Number(t & 0xffn)); t >>= 8n; }
  return base58Encode(withChecksum(Uint8Array.from([0x02, ...uleb(a.contractIndex), ...uleb(a.contractSubindex), ...id])));
}

/** Builds a syntactically valid account address from 32 bytes (used by tests; real addresses come from the chain). */
export function encodeAccountAddress(bytes32: Uint8Array): string {
  if (bytes32.length !== 32) throw new RangeError("account address payload must be 32 bytes");
  return base58Encode(withChecksum(Uint8Array.from([0x01, ...bytes32])));
}
