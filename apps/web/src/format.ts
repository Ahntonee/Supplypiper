import { convert, parseMajorToMinor, quantity, QUANTITY_SCALE, type UnitCode } from "@supplypiper/domain";
import type { OrgRole } from "@supplypiper/domain";
import { can, type Permission } from "@supplypiper/domain";
import type { OrgSummary } from "./api";

/** Exact string money helpers (integer minor units, never floats). */
export const minorToMajor = (minor: bigint | string): string => {
  const v = BigInt(minor);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
};

export const isMoney = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());
export const isQty = (s: string) => /^\d+(\.\d{1,6})?$/.test(s.trim());
export const toMinor = (s: string): bigint => parseMajorToMinor(s.trim(), 2);

/** Unit price x quantity, rounded half-up to a minor unit. Mirrors the server's arithmetic check. Null if units can't be compared. */
export function goodsFrom(unitPrice: string, qty: string, qtyUnit: UnitCode, priceUnit: UnitCode): string | null {
  if (!isMoney(unitPrice) || !isQty(qty)) return null;
  try {
    const inPriceUnit = convert(quantity(qty.trim(), qtyUnit), priceUnit);
    return minorToMajor((toMinor(unitPrice) * inPriceUnit.scaled + QUANTITY_SCALE / 2n) / QUANTITY_SCALE);
  } catch { return null; }
}

export interface ChargeInput { amount: string; unknown: boolean }
/** Landed total in minor units, or null when a required charge is unknown or unstated (mirrors the server rule). */
export function landedMinor(goods: string, delivery: ChargeInput, tax: ChargeInput, fees: Array<ChargeInput & { mandatory: boolean }>): bigint | null {
  if (!isMoney(goods)) return null;
  let total = toMinor(goods);
  for (const c of [delivery, tax]) { if (c.unknown || !isMoney(c.amount)) return null; total += toMinor(c.amount); }
  for (const f of fees) {
    if (f.unknown || !isMoney(f.amount)) { if (f.mandatory) return null; continue; }
    total += toMinor(f.amount);
  }
  return total;
}

/** UI mirror of the server's permission table. The server stays authoritative. */
export const mayDo = (org: OrgSummary | undefined, permission: Permission): boolean =>
  !!org && can(org.roles as OrgRole[], org.capabilities, permission);

/** <input type="datetime-local"> value for an ISO instant, in the viewer's timezone. */
export const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
