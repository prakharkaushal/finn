/**
 * Indian fiscal periods. FY27 runs Apr 2026 – Mar 2027; Q1 ends June, Q4 ends March.
 * Period ends are ISO dates ("2026-09-30"), which is also how screener.in keys its columns.
 */

export type QuarterRef = { end: string; fy: number; q: 1 | 2 | 3 | 4; label: string };

const QUARTER_BY_MONTH: Record<number, 1 | 2 | 3 | 4> = { 6: 1, 9: 2, 12: 3, 3: 4 };

export function fyLabel(fy: number): string {
  return `FY${String(fy % 100).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A real quarter-end date (31 Mar, 30 Jun, 30 Sep, 31 Dec): the only periods results are reported for. */
export function isQuarterEnd(s: string): boolean {
  return /^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(s);
}

export function quarterOf(end: string): QuarterRef | null {
  const m = end.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const q = QUARTER_BY_MONTH[month];
  if (!q) return null;
  const fy = month === 3 ? year : year + 1;
  return { end, fy, q, label: `Q${q} ${fyLabel(fy)}` };
}

/** Quarter end (ISO) that contains the given year/month. */
export function quarterEndFor(year: number, month: number): string {
  const endMonth = Math.ceil(month / 3) * 3;
  return iso(year, endMonth, lastDayOfMonth(year, endMonth));
}

/** Shift a quarter end by n quarters (n = -1 → previous quarter, -4 → same quarter last year). */
export function shiftQuarter(end: string, n: number): string {
  const [y, mo] = end.split("-").map(Number);
  const total = y * 12 + (mo - 1) + n * 3;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return iso(year, month, lastDayOfMonth(year, month));
}

/** The latest quarter that had fully ended before `date` — the default for a results filing. */
export function lastCompletedQuarter(date: Date): string {
  const ist = new Date(date.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1;
  const currentEnd = quarterEndFor(y, m);
  return shiftQuarter(currentEnd, -1);
}

/** Annual column key → fiscal year: "2026-03-31" → 2026. Non-March year ends keep their calendar year. */
export function fiscalYearOf(key: string): number | null {
  const m = key.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month <= 3 ? year : year + 1;
}

/** Concall month (e.g. "2026-07") → the quarter whose results that call discussed. */
export function quarterDiscussedOnCall(month: string): QuarterRef | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15));
  return quarterOf(lastCompletedQuarter(date));
}
