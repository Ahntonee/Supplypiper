/** Exact money in integer minor units (kobo for NGN). No floating point anywhere. */
export interface Money {
  readonly minor: bigint;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export function money(minor: bigint | number, currency: string): Money {
  const m = typeof minor === "number" ? BigInt(minor) : minor;
  if (typeof minor === "number" && !Number.isSafeInteger(minor)) {
    throw new RangeError("Money minor units must be a safe integer; pass a bigint");
  }
  if (!/^[A-Z]{3,5}$/.test(currency)) throw new RangeError(`Invalid currency code: ${currency}`);
  return { minor: m, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function sumMoney(items: readonly Money[], currency: string): Money {
  return items.reduce((acc, m) => addMoney(acc, m), money(0n, currency));
}

/** Format NGN-like 2-decimal currencies from minor units, without floats. */
export function formatMinor(m: Money, decimals = 2): string {
  const neg = m.minor < 0n;
  const abs = neg ? -m.minor : m.minor;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${m.currency} ${whole}.${frac}`;
}

/** Parse "120000.50" into minor units (2 decimals). Rejects more precision than representable. */
export function parseMajorToMinor(input: string, decimals = 2): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!m) throw new RangeError(`Invalid amount: ${input}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`Too many decimal places: ${input}`);
  return BigInt(m[1]! + frac.padEnd(decimals, "0"));
}
