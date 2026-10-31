import { cagr, formatCroreInr, pctChange } from "@/lib/domain/numbers";
import { fiscalYearOf, fyLabel, quarterOf, shiftQuarter } from "@/lib/domain/periods";
import type { StatementSet, StatementTable } from "@/lib/data/schema";
import type { Figure } from "@/lib/data/schema";
import type { Claim, QuarterTable, ResearchReport } from "@/lib/research/types";

/**
 * Deterministic read of the standardised statements: growth, margins, leverage, cash
 * conversion and the working-capital cycle, each stated as a claim with its period and a
 * citation to the exact screener.in table it came from. No model is involved.
 */

const SRC = "screener";
const cite = (section: string) => [{ sourceId: SRC, section }];

type Col = { key: string; label: string; idx: number };

/** Fiscal-year columns (drops TTM), oldest → newest. */
function yearColumns(t: StatementTable, max = 6): Col[] {
  return t.periods
    .map((p, idx) => ({ key: p.key, idx, fy: fiscalYearOf(p.key) }))
    .filter((c): c is { key: string; idx: number; fy: number } => c.fy != null)
    .slice(-max)
    .map((c) => ({ key: c.key, idx: c.idx, label: fyLabel(c.fy) }));
}

function row(t: StatementTable, names: string[], cols: Col[]): (number | null)[] {
  const name = names.find((n) => n in t.rows);
  return cols.map((c) => (name ? (t.rows[name][c.idx] ?? null) : null));
}

const pct = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
const cr = (v: number) => formatCroreInr(v);
const sub = (a: (number | null)[], b: (number | null)[]) => a.map((x, i) => (x == null || b[i] == null ? null : x - (b[i] as number)));
const add = (a: (number | null)[], b: (number | null)[]) => a.map((x, i) => (x == null || b[i] == null ? null : x + (b[i] as number)));
const div = (a: (number | null)[], b: (number | null)[], scale = 1) =>
  a.map((x, i) => (x == null || b[i] == null || b[i] === 0 ? null : (x / (b[i] as number)) * scale));

/** The reported figures a claim rests on, so they can be traced to a primary document. */
function figures(metric: Figure["metric"], cols: Col[], values: (number | null)[], idx: number[]): Figure[] {
  return idx.flatMap((i) => {
    const fy = cols[i] ? fiscalYearOf(cols[i].key) : null;
    const v = values[i];
    return fy != null && v != null ? [{ metric, fy, value: v }] : [];
  });
}

function lastIndex(values: (number | null)[]) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
}

export function analyzeFinancials(c: StatementSet): Pick<ResearchReport, "headline" | "trajectory" | "quarters" | "balanceSheet" | "cash" | "workingCapital"> {
  const lender = c.isLender;
  const revNames = ["sales", "revenue"];

  // ---- Trajectory (annual P&L)
  const years = yearColumns(c.annual);
  const revenue = row(c.annual, revNames, years);
  const ebitda = lender ? sub(revenue, row(c.annual, ["interest"], years)) : row(c.annual, ["operating profit"], years);
  const pat = row(c.annual, ["net profit"], years);
  const margin = div(ebitda, revenue, 100);
  const trajClaims: Claim[] = [];
  const first = revenue.findIndex((v) => v != null);
  const last = lastIndex(revenue);
  if (first >= 0 && last > first) {
    const span = last - first;
    const g = cagr(revenue[first], revenue[last], span);
    if (g != null) {
      trajClaims.push({
        id: "traj-revenue-cagr",
        text: `Revenue compounded at ${pct(g)} a year over ${years[first].label}–${years[last].label} (${cr(revenue[first]!)} → ${cr(revenue[last]!)}).`,
        tone: g >= 12 ? "positive" : g < 5 ? "negative" : "neutral",
        period: `${years[first].label}–${years[last].label}`,
        citations: cite("profit-loss"),
        figures: figures("revenue", years, revenue, [last, first]),
      });
    }
    const growth = revenue.map((v, i) => (i === 0 ? null : pctChange(v, revenue[i - 1])));
    const latest = growth[last];
    const prior = growth.slice(1, last).filter((x): x is number => x != null);
    if (latest != null && prior.length >= 2) {
      const slowest = latest < Math.min(...prior);
      const fastest = latest > Math.max(...prior);
      trajClaims.push({
        id: "traj-latest-growth",
        text: `${years[last].label} revenue growth of ${pct(latest)} was ${slowest ? `the slowest in ${prior.length + 1} years` : fastest ? `the fastest in ${prior.length + 1} years` : `within its ${prior.length + 1}-year range (${pct(Math.min(...prior))} to ${pct(Math.max(...prior))})`}.`,
        tone: slowest ? "negative" : fastest ? "positive" : "neutral",
        period: years[last].label,
        citations: cite("profit-loss"),
        figures: figures("revenue", years, revenue, [last, last - 1]),
      });
    }
  }
  const mLast = lastIndex(margin);
  const mBase = mLast - 3;
  if (!lender && mLast >= 3 && margin[mBase] != null && margin[mLast] != null) {
    const bps = Math.round((margin[mLast]! - margin[mBase]!) * 100);
    trajClaims.push({
      id: "traj-margin",
      text: `EBITDA margin ${bps >= 0 ? "expanded" : "compressed"} by ${Math.abs(bps)} bps over ${years[mBase].label}–${years[mLast].label} (${pct(margin[mBase]!)} → ${pct(margin[mLast]!)}).`,
      tone: bps >= 50 ? "positive" : bps <= -100 ? "negative" : "neutral",
      period: `${years[mBase].label}–${years[mLast].label}`,
      citations: cite("profit-loss"),
    });
  }
  const pFirst = pat.findIndex((v) => v != null);
  const pLast = lastIndex(pat);
  if (pFirst >= 0 && pLast > pFirst) {
    const pg = cagr(pat[pFirst], pat[pLast], pLast - pFirst);
    const rg = first >= 0 && last > first ? cagr(revenue[first], revenue[last], last - first) : null;
    if (pg != null) {
      trajClaims.push({
        id: "traj-pat-cagr",
        text: `PAT compounded at ${pct(pg)} a year over ${years[pFirst].label}–${years[pLast].label}${rg != null ? (pg < rg - 2 ? ", lagging revenue" : pg > rg + 2 ? ", ahead of revenue" : ", in line with revenue") : ""}.`,
        tone: pg >= 12 ? "positive" : pg < 5 ? "negative" : "neutral",
        period: `${years[pFirst].label}–${years[pLast].label}`,
        citations: cite("profit-loss"),
        figures: figures("pat", years, pat, [pLast, pFirst]),
      });
    } else if (pat[pLast] != null && pat[pLast]! < 0) {
      trajClaims.push({ id: "traj-pat-loss", text: `The company reported a loss of ${cr(Math.abs(pat[pLast]!))} in ${years[pLast].label}.`, tone: "negative", period: years[pLast].label, citations: cite("profit-loss"), figures: figures("pat", years, pat, [pLast]) });
    }
  }

  // ---- Last 8 quarters
  const qCols = c.quarters.periods.map((p, idx) => ({ key: p.key, idx })).slice(-8);
  const qAt = (names: string[], key: string) => {
    const name = names.find((x) => x in c.quarters.rows);
    const idx = c.quarters.periods.findIndex((p) => p.key === key);
    return name && idx >= 0 ? (c.quarters.rows[name][idx] ?? null) : null;
  };
  const qRev = qCols.map((q) => qAt(revNames, q.key));
  const qEbitda = lender ? qCols.map((q) => { const r = qAt(revNames, q.key); const i = qAt(["interest"], q.key); return r == null || i == null ? null : r - i; }) : qCols.map((q) => qAt(["operating profit"], q.key));
  const qPat = qCols.map((q) => qAt(["net profit"], q.key));
  const quarters: QuarterTable = {
    keys: qCols.map((q) => q.key),
    labels: qCols.map((q) => quarterOf(q.key)?.label ?? q.key),
    revenue: qRev,
    ebitda: qEbitda,
    pat: qPat,
    margin: div(qEbitda, qRev, 100),
    revenueYoY: qCols.map((q, i) => pctChange(qRev[i], qAt(revNames, shiftQuarter(q.key, -4)))),
    patYoY: qCols.map((q, i) => pctChange(qPat[i], qAt(["net profit"], shiftQuarter(q.key, -4)))),
  };

  // ---- Headline: latest quarter and trailing twelve months
  const headline: Claim[] = [];
  const lq = qCols.length - 1;
  if (lq >= 0 && quarters.revenue[lq] != null) {
    const label = quarters.labels[lq];
    const ry = quarters.revenueYoY[lq];
    const py = quarters.patYoY[lq];
    headline.push({
      id: "head-latest-quarter",
      text: `${label}: revenue ${cr(quarters.revenue[lq]!)}${ry != null ? ` (${ry >= 0 ? "+" : ""}${pct(ry)} YoY)` : ""}, PAT ${quarters.pat[lq] != null ? cr(quarters.pat[lq]!) : "n/a"}${py != null ? ` (${py >= 0 ? "+" : ""}${pct(py)} YoY)` : ""}.`,
      tone: ry != null && py != null ? (ry > 0 && py > 0 ? "positive" : ry < 0 && py < 0 ? "negative" : "neutral") : "neutral",
      period: label,
      citations: cite("quarters"),
      figures: (["revenue", "pat"] as const).flatMap((metric) => {
        const v = metric === "revenue" ? quarters.revenue[lq] : quarters.pat[lq];
        const fy = fiscalYearOf(qCols[lq].key);
        return v != null && fy != null ? [{ metric, fy, quarter: qCols[lq].key, value: v }] : [];
      }),
    });
  }
  const ttmIdx = c.annual.periods.findIndex((p) => p.key === "TTM");
  if (ttmIdx >= 0) {
    const get = (names: string[]) => {
      const name = names.find((x) => x in c.annual.rows);
      return name ? (c.annual.rows[name][ttmIdx] ?? null) : null;
    };
    const tRev = get(revNames);
    const tE = lender ? (tRev != null && get(["interest"]) != null ? tRev - get(["interest"])! : null) : get(["operating profit"]);
    const tPat = get(["net profit"]);
    if (tRev != null) {
      headline.push({
        id: "head-ttm",
        text: `Trailing twelve months: revenue ${cr(tRev)}${tE != null ? `, ${lender ? "NII" : "EBITDA"} ${cr(tE)}${!lender ? ` (${pct((tE / tRev) * 100)} margin)` : ""}` : ""}${tPat != null ? `, PAT ${cr(tPat)}` : ""}.`,
        tone: "neutral",
        period: "TTM",
        citations: cite("profit-loss"),
      });
    }
  }

  // ---- Balance sheet
  const bYears = yearColumns(c.balanceSheet);
  const borrowings = row(c.balanceSheet, ["borrowings", "borrowing"], bYears);
  const equity = add(row(c.balanceSheet, ["equity capital"], bYears), row(c.balanceSheet, ["reserves"], bYears));
  const de = div(borrowings, equity);
  const bsClaims: Claim[] = [];
  const bl = lastIndex(de);
  if (lender) {
    bsClaims.push({ id: "bs-lender", text: "Borrowings are a lender's raw material, so debt-to-equity is not a risk signal here; asset quality (NPAs) matters more.", tone: "neutral", citations: cite("balance-sheet") });
  } else if (bl >= 0) {
    const base = bl >= 3 ? bl - 3 : 0;
    const d = de[bl]!;
    bsClaims.push({
      id: "bs-de",
      text: `Debt-to-equity was ${d.toFixed(2)} at ${bYears[bl].label} end${de[base] != null && base !== bl ? ` (${de[base]!.toFixed(2)} at ${bYears[base].label})` : ""}.`,
      tone: d < 0.5 ? "positive" : d > 1.5 ? "negative" : "neutral",
      period: bYears[bl].label,
      citations: cite("balance-sheet"),
    });
    if (borrowings[base] && borrowings[bl] != null && base !== bl) {
      const x = borrowings[bl]! / borrowings[base]!;
      if (x >= 1.5 || x <= 0.6) {
        bsClaims.push({
          id: "bs-borrowings",
          text: `Borrowings ${x >= 1 ? `rose ${x.toFixed(1)}×` : `fell ${Math.round((1 - x) * 100)}%`} from ${cr(borrowings[base]!)} to ${cr(borrowings[bl]!)} over ${bYears[base].label}–${bYears[bl].label}.`,
          tone: x >= 1.5 ? "negative" : "positive",
          period: `${bYears[base].label}–${bYears[bl].label}`,
          citations: cite("balance-sheet"),
        });
      }
    }
  }

  // ---- Cash quality
  const cYears = yearColumns(c.cashFlow);
  const cfo = row(c.cashFlow, ["cash from operating activity"], cYears);
  const fcf = row(c.cashFlow, ["free cash flow"], cYears);
  const capex = sub(cfo, fcf);
  const patForCash = cYears.map((y) => {
    const idx = c.annual.periods.findIndex((p) => p.key === y.key);
    const name = ["net profit"].find((x) => x in c.annual.rows);
    return idx >= 0 && name ? (c.annual.rows[name][idx] ?? null) : null;
  });
  const cashClaims: Claim[] = [];
  if (lender) {
    cashClaims.push({ id: "cash-lender", text: "For lenders, loan growth runs through operating cash flow, so CFO-to-profit conversion is not meaningful.", tone: "neutral", citations: cite("cash-flow") });
  } else {
    const pairs = cfo.map((v, i) => [v, patForCash[i]] as const).filter(([a, b]) => a != null && b != null).slice(-5);
    const sumCfo = pairs.reduce((s, [a]) => s + a!, 0);
    const sumPat = pairs.reduce((s, [, b]) => s + b!, 0);
    if (pairs.length >= 3 && sumPat > 0) {
      const conv = sumCfo / sumPat;
      cashClaims.push({
        id: "cash-conversion",
        text:
          sumCfo < 0
            ? `Over the last ${pairs.length} years, operating cash flow totalled ${cr(sumCfo)} against ${cr(sumPat)} of reported profit — operations consumed cash rather than generating it.`
            : `Over the last ${pairs.length} years, operating cash flow was ${conv.toFixed(2)}× reported profit (${cr(sumCfo)} vs ${cr(sumPat)}) — ${conv >= 0.9 ? "profits are turning into cash" : conv >= 0.7 ? "conversion is partial" : "profits are not fully turning into cash"}.`,
        tone: conv >= 0.9 ? "positive" : conv < 0.7 ? "negative" : "neutral",
        period: `last ${pairs.length} fiscal years`,
        citations: [...cite("cash-flow"), ...cite("profit-loss")],
        figures: figures("cfo", cYears, cfo, [lastIndex(cfo), lastIndex(cfo) - 1]),
      });
    }
    const f = fcf.filter((v): v is number => v != null).slice(-5);
    if (f.length >= 3) {
      const positive = f.filter((v) => v > 0).length;
      cashClaims.push({
        id: "cash-fcf",
        text: `Free cash flow (as computed by screener.in) was positive in ${positive} of the last ${f.length} years, ${cr(f.reduce((a, b) => a + b, 0))} in total.`,
        tone: positive >= f.length - 1 ? "positive" : positive <= 1 ? "negative" : "neutral",
        period: `last ${f.length} fiscal years`,
        citations: cite("cash-flow"),
      });
    }
    // screener.in defines free cash flow as operating cash flow less capex, so capex = CFO − FCF.
    const capexPairs = capex.map((v, i) => [v, cfo[i]] as const).filter(([a, b]) => a != null && b != null).slice(-5);
    if (capexPairs.length >= 3) {
      const spent = capexPairs.reduce((s, [a]) => s + a!, 0);
      const generated = capexPairs.reduce((s, [, b]) => s + b!, 0);
      const share = generated > 0 ? (spent / generated) * 100 : null;
      cashClaims.push({
        id: "cash-capex",
        text: `Capex over the last ${capexPairs.length} years was ${cr(spent)}${share != null ? `, ${share.toFixed(0)}% of operating cash flow` : `, while operations consumed ${cr(Math.abs(generated))}`} (derived as operating cash flow − free cash flow).`,
        tone: share != null && share > 120 ? "negative" : "neutral",
        period: `last ${capexPairs.length} fiscal years`,
        citations: cite("cash-flow"),
      });
    }
  }

  // ---- Working capital
  const rYears = yearColumns(c.ratios);
  const ccc = row(c.ratios, ["cash conversion cycle"], rYears);
  const debtorDays = row(c.ratios, ["debtor days"], rYears);
  const inventoryDays = row(c.ratios, ["inventory days"], rYears);
  const roce = row(c.ratios, ["roce %"], rYears);
  const wcClaims: Claim[] = [];
  const cl = lastIndex(ccc);
  if (!lender && cl >= 3 && ccc[cl - 3] != null) {
    const delta = ccc[cl]! - ccc[cl - 3]!;
    wcClaims.push({
      id: "wc-ccc",
      text: `Cash conversion cycle ${Math.abs(delta) < 5 ? "held steady" : delta > 0 ? "lengthened" : "shortened"} from ${ccc[cl - 3]} to ${ccc[cl]} days over ${rYears[cl - 3].label}–${rYears[cl].label}.`,
      tone: delta > 15 ? "negative" : delta < -10 ? "positive" : "neutral",
      period: `${rYears[cl - 3].label}–${rYears[cl].label}`,
      citations: cite("ratios"),
    });
  }
  const rl = lastIndex(roce);
  if (rl >= 0) {
    wcClaims.push({
      id: "wc-roce",
      text: `Return on capital employed was ${roce[rl]}% in ${rYears[rl].label}${rl >= 3 && roce[rl - 3] != null ? ` (${roce[rl - 3]}% in ${rYears[rl - 3].label})` : ""}.`,
      tone: roce[rl]! >= 18 ? "positive" : roce[rl]! < 10 ? "negative" : "neutral",
      period: rYears[rl].label,
      citations: cite("ratios"),
    });
  }

  return {
    headline,
    trajectory: { years: years.map((y) => y.label), revenue, ebitda, pat, margin, claims: trajClaims },
    quarters,
    balanceSheet: { years: bYears.map((y) => y.label), borrowings, equity, debtToEquity: de, claims: bsClaims },
    cash: { years: cYears.map((y) => y.label), cfo, pat: patForCash, fcf, capex, claims: cashClaims },
    workingCapital: { years: rYears.map((y) => y.label), ccc, debtorDays, inventoryDays, claims: wcClaims },
  };
}
