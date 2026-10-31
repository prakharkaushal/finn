/**
 * Plain arithmetic for financial comparisons. Deliberately not an LLM's job: these are
 * exact, cheap, and unit-tested. Shared by server and client.
 */

export type Change =
  | { kind: "pct"; value: number }
  | { kind: "turned_positive" }
  | { kind: "turned_negative" }
  | { kind: "loss_narrowed"; value: number }
  | { kind: "loss_widened"; value: number }
  /** missing: one of the two figures is not in the source · zero-base: the earlier figure is 0. */
  | { kind: "na"; reason: "missing" | "zero-base" };

/**
 * Percentage change that stays honest around zero and negative bases: a % change off a
 * loss or off zero is meaningless, so those cases are described instead of computed.
 */
export function change(current: number | null | undefined, previous: number | null | undefined): Change {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return { kind: "na", reason: "missing" };
  if (previous === 0) return { kind: "na", reason: "zero-base" };
  if (previous > 0) {
    if (current < 0) return { kind: "turned_negative" };
    return { kind: "pct", value: ((current - previous) / previous) * 100 };
  }
  if (current >= 0) return { kind: "turned_positive" };
  const delta = current - previous;
  return delta >= 0 ? { kind: "loss_narrowed", value: delta } : { kind: "loss_widened", value: delta };
}

export function pctChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  const c = change(current, previous);
  return c.kind === "pct" ? c.value : null;
}

/** Compound annual growth rate over `years`; null when either end is non-positive. */
export function cagr(first: number | null | undefined, last: number | null | undefined, years: number): number | null {
  if (first == null || last == null || first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

export function ratio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

export function margin(profit: number | null | undefined, revenue: number | null | undefined): number | null {
  const r = ratio(profit, revenue);
  return r == null ? null : r * 100;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function sum(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  return present.length === values.length && present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
}

/** ₹ crore with Indian digit grouping: 123456.7 → "1,23,457". */
export function formatCrore(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** A value already in ₹ crore → "₹3,626 cr" / "−₹600 cr" (the sign goes before the symbol). */
export function formatCroreInr(value: number | null | undefined, digits = 0, suffix = " cr"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value < 0 ? "−" : ""}₹${formatCrore(Math.abs(value), digits)}${suffix}`;
}

/** Raw INR → "₹9.85 cr" / "₹4,200 cr" / "₹85.0 lakh". */
export function formatInr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  const crore = Math.abs(value) / 1e7;
  if (crore >= 100) return `${sign}₹${formatCrore(crore)} cr`;
  if (crore >= 1) return `${sign}₹${crore.toFixed(2)} cr`;
  return `${sign}₹${(Math.abs(value) / 1e5).toFixed(1)} lakh`;
}

export function formatPct(value: number | null | undefined, digits = 1, signed = true): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const s = Math.abs(value).toFixed(digits);
  if (value < 0 && Number(s) !== 0) return `−${s}%`;
  return signed && value > 0 ? `+${s}%` : `${s}%`;
}

export function describeChange(c: Change): string {
  switch (c.kind) {
    case "pct":
      return formatPct(c.value);
    case "turned_positive":
      return "turned profitable";
    case "turned_negative":
      return "turned to loss";
    case "loss_narrowed":
      return "loss narrowed";
    case "loss_widened":
      return "loss widened";
    case "na":
      return c.reason === "zero-base" ? "n/a — the earlier figure was zero" : "n/a — no figure for the earlier period in the source";
  }
}
