/** JSON-safe view: bigint -> decimal string, Date -> ISO UTC. Money/quantities are never sent as floats. */
export function ser<T>(v: T): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ser(x)]));
  }
  return v;
}
