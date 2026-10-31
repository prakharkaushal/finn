import { NoDataError, refFrom, type FundamentalsProvider } from "@/lib/data/providers";
import type { CompanyFundamentals, ExtractionIssue, FinancialMetric, PeriodValue, PrimarySource, SourceRef } from "@/lib/data/schema";
import { quarterDiscussedOnCall } from "@/lib/domain/periods";
import { SourceError } from "@/lib/net/http";
import { loadScreenerCompany, type ScreenerCompany } from "@/lib/sources/screener";

export const screenerFundamentals: FundamentalsProvider = {
  id: "screener",
  label: "screener.in company pages",
  kind: "fundamentals",
  note: "Standardised statements compiled from company filings, plus links to annual reports and call transcripts (the documents themselves are the evidence). Only /company/<SYMBOL>/ pages, which robots.txt allows; cached 30 min.",
  async company(symbol, opts) {
    try {
      const page = await loadScreenerCompany(symbol, opts);
      return toFundamentals(page.value, refFrom("screener", "aggregator", page.value.url, page));
    } catch (err) {
      if (err instanceof SourceError && err.status === 404) throw new NoDataError(err.message);
      throw err;
    }
  },
};

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function hostOf(url: string, website?: string): PrimarySource["host"] {
  const host = hostname(url);
  if (!host) return "other";
  if (host.endsWith("bseindia.com")) return "BSE";
  if (host.endsWith("nseindia.com")) return "NSE";
  const site = website ? hostname(website) : null;
  if (site && (host === site || host.endsWith(`.${site}`))) return "company";
  return "other";
}

/** The documents a company page links to. Discovery only: nothing is fetched here. */
export function documentsFrom(c: ScreenerCompany, discoveredVia: SourceRef): PrimarySource[] {
  const docs: PrimarySource[] = [];
  const seenUrls = new Set<string>();
  const seenIds = new Map<string, number>();
  const add = (d: Pick<PrimarySource, "id" | "kind" | "title" | "url" | "period" | "date">) => {
    if (!d.url || seenUrls.has(d.url) || !URL.canParse(d.url)) return;
    seenUrls.add(d.url);
    const n = (seenIds.get(d.id) ?? 0) + 1;
    seenIds.set(d.id, n);
    docs.push({
      ...d,
      id: n > 1 ? `${d.id}-${n}` : d.id,
      symbol: c.symbol,
      host: hostOf(d.url, c.website),
      discoveredVia,
      retrieval: { status: "not_fetched" },
    });
  };
  for (const ar of c.annualReports) {
    add({ id: `ar-${ar.year}`, kind: "annual_report", title: `Annual report ${ar.year}`, url: ar.url, period: `FY${String(ar.year).slice(2)}`, date: String(ar.year) });
  }
  for (const call of c.concalls) {
    const quarter = call.month ? quarterDiscussedOnCall(call.month)?.label : undefined;
    const date = call.month || undefined;
    const key = call.month || "undated";
    if (call.transcriptUrl) add({ id: `transcript-${key}`, kind: "transcript", title: `Earnings-call transcript, ${call.label}`, url: call.transcriptUrl, period: quarter, date });
    if (call.pptUrl) add({ id: `presentation-${key}`, kind: "presentation", title: `Investor presentation, ${call.label}`, url: call.pptUrl, period: quarter, date });
    if (call.recordingUrl) add({ id: `recording-${key}`, kind: "recording", title: `Call recording, ${call.label}`, url: call.recordingUrl, period: quarter, date });
  }
  for (const r of c.creditRatings) add({ id: "rating", kind: "credit_rating", title: r.title || "Credit rating", url: r.url });
  if (c.website) add({ id: "ir-website", kind: "ir_website", title: "Company website (entry point for investor-relations documents)", url: c.website });
  return docs;
}

export function toFundamentals(c: ScreenerCompany, source: SourceRef): CompanyFundamentals {
  const issues: ExtractionIssue[] = [];
  const tables = [
    ["quarterly results", c.quarters],
    ["annual profit and loss", c.annual],
    ["balance sheet", c.balanceSheet],
    ["cash flow", c.cashFlow],
  ] as const;
  for (const [label, t] of tables) {
    if (!t.periods.length) issues.push({ provider: source.provider, subject: `${c.symbol} ${label}`, message: "Table not found on the page" });
  }
  const website = c.website && URL.canParse(c.website) ? c.website : undefined;
  return {
    symbol: c.symbol,
    name: c.name,
    url: c.url,
    basis: c.basis,
    isLender: c.isLender,
    units: c.units,
    topRatios: c.topRatios,
    quarters: c.quarters,
    annual: c.annual,
    balanceSheet: c.balanceSheet,
    cashFlow: c.cashFlow,
    ratios: c.ratios,
    company: { symbol: c.symbol, exchange: "NSE", name: c.name, ...(website ? { website } : {}), ...(c.bseCode ? { bseCode: c.bseCode } : {}), source },
    documents: documentsFrom(c, source),
    source,
    issues,
  };
}

/** screener.in row keys FINN maps to canonical metrics; everything else keeps its own key. */
const ROW_METRIC: Record<string, FinancialMetric> = {
  sales: "revenue",
  revenue: "revenue",
  "operating profit": "ebitda",
  "opm %": "ebitda_margin",
  "financing profit": "financing_profit",
  depreciation: "depreciation",
  interest: "interest",
  "profit before tax": "pbt",
  "net profit": "pat",
  "eps in rs": "eps",
  borrowings: "borrowings",
  "equity capital": "equity_capital",
  reserves: "reserves",
  "total assets": "total_assets",
  "cash from operating activity": "cfo",
  "cash from investing activity": "cfi",
  "cash from financing activity": "cff",
  "free cash flow": "fcf",
  "debtor days": "debtor_days",
  "inventory days": "inventory_days",
  "days payable": "payable_days",
  "cash conversion cycle": "cash_conversion_cycle",
  "roce %": "roce",
};

export function unitOf(rowKey: string, units: string): PeriodValue["unit"] {
  if (rowKey.endsWith("%")) return "%";
  if (/\bdays\b|cycle/.test(rowKey)) return "days";
  if (rowKey.startsWith("eps")) return "INR";
  if (/no\. of shares|number of shares/.test(rowKey)) return "count";
  return /lakh/i.test(units) ? "INR_lakh" : "INR_cr";
}

const STATEMENTS = [
  ["quarters", "quarterly", "quarters"],
  ["annual", "annual", "profit-loss"],
  ["balanceSheet", "balance-sheet", "balance-sheet"],
  ["cashFlow", "cash-flow", "cash-flow"],
  ["ratios", "ratios", "ratios"],
] as const;

/** Every statement cell as a canonical record, pointing at the page section it came from. */
export function periodValues(f: CompanyFundamentals): PeriodValue[] {
  const out: PeriodValue[] = [];
  for (const [field, statement, anchor] of STATEMENTS) {
    const table = f[field];
    const source = { ...f.source, url: `${f.url}#${anchor}` };
    for (const row of table.order) {
      table.periods.forEach((p, i) => {
        out.push({
          symbol: f.symbol,
          statement,
          metric: ROW_METRIC[row] ?? row,
          label: row,
          basis: f.basis,
          period: { key: p.key, label: p.label, ...(/^\d{4}-\d{2}-\d{2}$/.test(p.key) ? { end: p.key } : {}) },
          value: table.rows[row]?.[i] ?? null,
          unit: unitOf(row, f.units),
          source,
        });
      });
    }
  }
  return out;
}
