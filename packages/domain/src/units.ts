/**
 * Quantities are scaled integers (6 decimal places) with an explicit unit.
 * Conversions only happen within one dimension. There is NO mass<->volume conversion
 * (no implicit kg->L for oil) and pack units need an explicit pack size.
 */
export const QUANTITY_SCALE = 1_000_000n;

export type Dimension = "volume" | "mass" | "count";
export type UnitCode = "mL" | "L" | "g" | "kg" | "each";

const UNITS: Record<UnitCode, { dimension: Dimension; factor: bigint }> = {
  mL: { dimension: "volume", factor: 1n },
  L: { dimension: "volume", factor: 1000n },
  g: { dimension: "mass", factor: 1n },
  kg: { dimension: "mass", factor: 1000n },
  each: { dimension: "count", factor: 1n },
};

export interface Quantity {
  /** value * 1_000_000 */
  readonly scaled: bigint;
  readonly unit: UnitCode;
}

export class UnitError extends Error {
  constructor(
    public readonly code: "INCOMPATIBLE_UNITS" | "INEXACT_CONVERSION" | "UNKNOWN_PACK_SIZE" | "INVALID_QUANTITY",
    message: string,
  ) {
    super(message);
    this.name = "UnitError";
  }
}

export function isUnitCode(u: string): u is UnitCode {
  return u in UNITS;
}

export function quantity(value: string, unit: UnitCode): Quantity {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new UnitError("INVALID_QUANTITY", `Invalid quantity: ${value}`);
  const scaled = BigInt(m[1]!) * QUANTITY_SCALE + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return { scaled, unit };
}

export function dimensionOf(u: UnitCode): Dimension {
  return UNITS[u].dimension;
}

export function areCompatible(a: UnitCode, b: UnitCode): boolean {
  return UNITS[a].dimension === UNITS[b].dimension;
}

/** Exact conversion inside a dimension; throws rather than rounding. */
export function convert(q: Quantity, to: UnitCode): Quantity {
  if (q.unit === to) return q;
  if (!areCompatible(q.unit, to)) {
    throw new UnitError("INCOMPATIBLE_UNITS", `Cannot convert ${q.unit} to ${to}`);
  }
  const num = q.scaled * UNITS[q.unit].factor;
  const den = UNITS[to].factor;
  if (num % den !== 0n) throw new UnitError("INEXACT_CONVERSION", `Inexact conversion ${q.unit}->${to}`);
  return { scaled: num / den, unit: to };
}

/** Packs -> base quantity. A missing pack size is an error, never a guess. */
export function packsToQuantity(packs: Quantity, packSize: Quantity | null | undefined): Quantity {
  if (!packSize) throw new UnitError("UNKNOWN_PACK_SIZE", "Pack size not stated");
  if (packs.unit !== "each") throw new UnitError("INCOMPATIBLE_UNITS", "Pack count must be in 'each'");
  return { scaled: (packs.scaled * packSize.scaled) / QUANTITY_SCALE, unit: packSize.unit };
}

/** Compare two quantities after exact conversion into the smaller-factor unit. */
export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  if (!areCompatible(a.unit, b.unit)) throw new UnitError("INCOMPATIBLE_UNITS", `${a.unit} vs ${b.unit}`);
  const x = a.scaled * UNITS[a.unit].factor;
  const y = b.scaled * UNITS[b.unit].factor;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function formatQuantity(q: Quantity): string {
  const whole = q.scaled / QUANTITY_SCALE;
  const frac = (q.scaled % QUANTITY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${q.unit}`;
}
