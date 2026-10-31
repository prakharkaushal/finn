import { change, margin, type Change } from "@/lib/domain/numbers";
import { quarterOf, shiftQuarter, type QuarterRef } from "@/lib/domain/periods";
import type { StatementSet, StatementTable } from "@/lib/data/schema";

/**
 * Headline numbers for a results filing: this quarter vs the previous quarter (QoQ) and the
 * same quarter last year (YoY). Deterministic arithmetic on one statement table, so a
 * comparison never mixes consolidated and standalone figures. Values are normalised to
 * ₹ crore; a figure the source does not have is reported as not found, never estimated.
 */

export type MetricKey = "revenue" | "ebitda" | "nii" | "pbt" | "pat";

export type HeadlineMetric = {
  key: MetricKey;
  label: string;
  /** not-found: no such row, or no value for this quarter · not-applicable: e.g. EBITDA for a lender. */
  status: "ok" | "not-found" | "not-applicable";
  current: number | null;
  prevQuarter: number | null;
  yearAgo: number | null;
  qoq: Change;
  yoy: Change;
  definition: string;
  /** The source row the figures came from (e.g. "sales"); null when none was found. */
  sourceRow: string | null;
};

export type MarginLine = { label: string; current: number | null; qoqBps: number | null; yoyBps: number | null };

export type ResultsSnapshot =
  | {
      status: "ok";
      quarter: QuarterRef;
      basis: "consolidated" | "standalone";
      isLender: boolean;
      /** The unit after normalisation: "₹ crore" whenever the source unit is known. */
      units: string;
      /** The source's own unit, when FINN converted from it. */
      convertedFrom?: string;
      metrics: HeadlineMetric[];
      margins: MarginLine[];
      comparedWith: { prevQuarter: string | null; yearAgo: string | null };
    }
  | { status: "quarter-missing"; quarter: QuarterRef | null; latestAvailable: string | null };

/** Multiplier from a statement's unit to ₹ crore; null when the unit is not recognised. */
export function toCroreFactor(units: string): number | null {
  const u = units.toLowerCase();
  if (/crore|\bcr\b/.test(u)) return 1;
  if (/lakh|\blacs?\b/.test(u)) return 0.01;
  if (/million|\bmn\b/.test(u)) return 0.1;
  if (/thousand|\b000s?\b/.test(u)) return 1e-4;
  if (/^\s*(₹|inr|rs\.?|rupees)\s*$/.test(u)) return 1e-7;
  return null;
}

function valueAt(table: StatementTable, row: string, key: string): number | null {
  const idx = table.periods.findIndex((p) => p.key === key);
  if (idx < 0) return null;
  return table.rows[row]?.[idx] ?? null;
}

function firstRow(table: StatementTable, candidates: string[]): string | null {
  return candidates.find((c) => c in table.rows) ?? null;
}

function bps(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : Math.round((a - b) * 100);
}

type Triple = { current: number | null; prevQuarter: number | null; yearAgo: number | null };

/** Revenue over the last four reported quarters, in ₹ crore; null when any of them is missing. */
export function ttmRevenueCr(company: StatementSet): number | null {
  const q = company.quarters;
  const row = firstRow(q, ["sales", "revenue"]);
  const factor = toCroreFactor(company.units);
  if (!row || factor == null) return null;
  const last4 = (q.rows[row] ?? []).slice(-4);
  if (last4.length < 4 || last4.some((v) => v == null)) return null;
  return Math.round(last4.reduce((s: number, v) => s + v!, 0) * factor * 100) / 100;
}

export function resultsSnapshot(company: StatementSet, periodEnd: string): ResultsSnapshot {
  const q = company.quarters;
  const quarter = quarterOf(periodEnd);
  if (!quarter || !q.periods.some((p) => p.key === periodEnd)) {
    return { status: "quarter-missing", quarter, latestAvailable: q.periods.at(-1)?.key ?? null };
  }
  const factor = toCroreFactor(company.units);
  const scale = (v: number | null) => (v == null || factor == null ? v : Math.round(v * factor * 100) / 100);
  const prevKey = shiftQuarter(periodEnd, -1);
  const yearKey = shiftQuarter(periodEnd, -4);
  const series = (row: string | null): Triple => ({
    current: row ? scale(valueAt(q, row, periodEnd)) : null,
    prevQuarter: row ? scale(valueAt(q, row, prevKey)) : null,
    yearAgo: row ? scale(valueAt(q, row, yearKey)) : null,
  });
  const metric = (key: MetricKey, label: string, row: string | null, s: Triple, definition: string): HeadlineMetric => ({
    key,
    label,
    status: s.current == null ? "not-found" : "ok",
    ...s,
    qoq: change(s.current, s.prevQuarter),
    yoy: change(s.current, s.yearAgo),
    definition,
    sourceRow: row,
  });

  const revenueRow = firstRow(q, ["sales", "revenue"]);
  const pbtRow = firstRow(q, ["profit before tax"]);
  const patRow = firstRow(q, ["net profit"]);
  const revenue = series(revenueRow);
  const pat = series(patRow);
  const metrics: HeadlineMetric[] = [metric("revenue", "Revenue", revenueRow, revenue, "Revenue from operations")];
  const margins: MarginLine[] = [];

  if (company.isLender) {
    const interestRow = firstRow(q, ["interest"]);
    const interest = series(interestRow);
    const sub = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((a - b) * 100) / 100);
    const nii = { current: sub(revenue.current, interest.current), prevQuarter: sub(revenue.prevQuarter, interest.prevQuarter), yearAgo: sub(revenue.yearAgo, interest.yearAgo) };
    metrics.push(metric("nii", "NII", revenueRow && interestRow ? `${revenueRow} − ${interestRow}` : null, nii, "Net interest income: revenue − interest expended."));
    const na: Change = { kind: "na", reason: "missing" };
    metrics.push({ key: "ebitda", label: "EBITDA", status: "not-applicable", current: null, prevQuarter: null, yearAgo: null, qoq: na, yoy: na, definition: "Not meaningful for a lender, whose interest cost is its cost of goods; NII is shown instead.", sourceRow: null });
  } else {
    const ebitdaRow = firstRow(q, ["operating profit"]);
    const ebitda = series(ebitdaRow);
    metrics.push(metric("ebitda", "EBITDA", ebitdaRow, ebitda, "Revenue − operating expenses (before other income, interest, depreciation and tax)"));
    const m = { c: margin(ebitda.current, revenue.current), p: margin(ebitda.prevQuarter, revenue.prevQuarter), y: margin(ebitda.yearAgo, revenue.yearAgo) };
    margins.push({ label: "EBITDA margin", current: m.c, qoqBps: bps(m.c, m.p), yoyBps: bps(m.c, m.y) });
  }
  metrics.push(metric("pbt", "PBT", pbtRow, series(pbtRow), "Profit before tax"));
  metrics.push(metric("pat", "PAT", patRow, pat, "Profit after tax (net profit)"));
  const patM = { c: margin(pat.current, revenue.current), p: margin(pat.prevQuarter, revenue.prevQuarter), y: margin(pat.yearAgo, revenue.yearAgo) };
  margins.push({ label: "PAT margin", current: patM.c, qoqBps: bps(patM.c, patM.p), yoyBps: bps(patM.c, patM.y) });

  const present = (key: string) => (q.periods.some((p) => p.key === key) ? key : null);
  return {
    status: "ok",
    quarter,
    basis: company.basis,
    isLender: company.isLender,
    units: factor == null ? company.units : "₹ crore",
    ...(factor != null && factor !== 1 ? { convertedFrom: company.units } : {}),
    metrics,
    margins,
    comparedWith: { prevQuarter: present(prevKey), yearAgo: present(yearKey) },
  };
}
