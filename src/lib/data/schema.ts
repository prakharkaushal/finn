import { z } from "zod";

/**
 * FINN's canonical records. Every provider normalises into these shapes, so a source can be
 * replaced without touching the inbox or research logic. Each record says where it came from
 * (SourceRef): the adapter, the URL it was read from, when FINN retrieved it, and whether it is
 * live, cached, stale, a committed snapshot, or demo data. Records are validated with these
 * schemas at the adapter boundary; rows that fail are dropped and reported as issues.
 */

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

// ---- Where a record came from ---------------------------------------------------------------

/**
 * live: fetched now · cache: within its freshness window · stale: the live fetch failed and an
 * older copy was served · snapshot: committed capture used as a fallback · demo: demo mode.
 */
export const DATA_MODES = ["live", "cache", "stale", "snapshot", "demo"] as const;
export const DataModeSchema = z.enum(DATA_MODES);
export type DataMode = z.infer<typeof DataModeSchema>;

export const SOURCE_TYPES = ["exchange", "market-data", "aggregator", "company", "demo"] as const;

export const SourceRefSchema = z.object({
  /** Adapter id, e.g. "yahoo-chart", "nse-api", "screener". */
  provider: z.string().min(1),
  type: z.enum(SOURCE_TYPES),
  /** Where the record was read: a feed, an API query or a page. Documents also carry their own URL. */
  url: z.url(),
  /** When FINN fetched it. For demo and snapshot data: when the seed was captured. */
  retrievedAt: isoDateTime,
  mode: DataModeSchema,
  /** Why a fallback was served, when one was. */
  note: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Something a provider could not extract. Recorded, shown in the status view, never silently dropped. */
export const ExtractionIssueSchema = z.object({
  provider: z.string(),
  subject: z.string(),
  message: z.string(),
});
export type ExtractionIssue = z.infer<typeof ExtractionIssueSchema>;

// ---- Companies and instruments --------------------------------------------------------------

export const ExchangeSchema = z.enum(["NSE", "BSE"]);
export const InstrumentSchema = z.object({ exchange: ExchangeSchema, code: z.string().regex(/^[A-Z0-9][A-Z0-9&-]{0,19}$/) });

export const CompanySchema = z.object({
  /** NSE trading symbol: FINN's key for a company. */
  symbol: z.string(),
  exchange: ExchangeSchema,
  name: z.string().min(1),
  isin: z.string().optional(),
  series: z.string().optional(),
  website: z.url().optional(),
  bseCode: z.string().optional(),
  source: SourceRefSchema,
});
export type Company = z.infer<typeof CompanySchema>;

// ---- Prices ----------------------------------------------------------------------------------

export const PriceBarSchema = z.object({
  /** Trading session (IST calendar date). */
  date: isoDate,
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  /** Close as the provider reports it — see PriceSeries.adjustment. */
  close: z.number().positive(),
  /** Close adjusted for splits and dividends; null when the provider has none. */
  adjClose: z.number().positive().nullable(),
  volume: z.number().nonnegative().nullable(),
});
export type PriceBar = z.infer<typeof PriceBarSchema>;

export const PriceSeriesSchema = z.object({
  instrument: InstrumentSchema,
  /** The provider's own symbol, e.g. "TCS.BO". */
  providerSymbol: z.string(),
  name: z.string().optional(),
  currency: z.string(),
  adjustment: z.object({
    /** as-traded: exchange prices (bhavcopy); split-adjusted: Yahoo's Close. */
    close: z.enum(["as-traded", "split-adjusted"]),
    adjClose: z.enum(["split-and-dividend"]).nullable(),
  }),
  /** True while the session is trading: the last bar is then partial. */
  sessionOpen: z.boolean(),
  bars: z.array(PriceBarSchema),
  source: SourceRefSchema,
  issues: z.array(ExtractionIssueSchema),
});
export type PriceSeries = z.infer<typeof PriceSeriesSchema>;

// ---- Announcements ---------------------------------------------------------------------------

/** Which listing supplied an announcement; demo data keeps its original listing and says "demo" in source.mode. */
export const ANNOUNCEMENT_VIA = ["nse-rss", "nse-api", "archive", "screener"] as const;

export const AnnouncementSchema = z.object({
  id: z.string(),
  symbol: z.string().nullable(),
  companyName: z.string(),
  /** Exchange-assigned subject, e.g. "Outcome of Board Meeting". */
  subject: z.string(),
  description: z.string(),
  /** The filing document itself — the primary source. */
  url: z.url(),
  docType: z.enum(["pdf", "xbrl", "zip", "other"]),
  /** Filing time with IST offset. */
  ts: isoDateTime,
  exchange: ExchangeSchema,
  /** Which listing supplied it. */
  via: z.enum(ANNOUNCEMENT_VIA),
  source: SourceRefSchema,
});
export type Announcement = z.infer<typeof AnnouncementSchema>;
/** An announcement as a parser produces it, before an adapter says where it came from. */
export type RawAnnouncement = Omit<Announcement, "source">;

// ---- Fundamentals ----------------------------------------------------------------------------

export const STATEMENTS = ["quarterly", "annual", "balance-sheet", "cash-flow", "ratios"] as const;
export const UNITS = ["INR_cr", "INR_lakh", "INR", "%", "days", "count", "ratio"] as const;

/** Canonical metric keys FINN maps statement rows to. Unmapped rows keep the source's own key. */
export const FINANCIAL_METRICS = {
  revenue: "Revenue from operations",
  ebitda: "Operating profit (EBITDA)",
  ebitda_margin: "Operating margin",
  depreciation: "Depreciation",
  interest: "Interest",
  pbt: "Profit before tax",
  pat: "Net profit (PAT)",
  eps: "Earnings per share",
  financing_profit: "Financing profit (lenders)",
  borrowings: "Borrowings",
  equity_capital: "Equity capital",
  reserves: "Reserves",
  total_assets: "Total assets",
  cfo: "Cash from operating activity",
  cfi: "Cash from investing activity",
  cff: "Cash from financing activity",
  fcf: "Free cash flow",
  debtor_days: "Debtor days",
  inventory_days: "Inventory days",
  payable_days: "Days payable",
  cash_conversion_cycle: "Cash conversion cycle",
  roce: "Return on capital employed",
} as const;
export type FinancialMetric = keyof typeof FINANCIAL_METRICS;

export const PeriodValueSchema = z.object({
  symbol: z.string(),
  statement: z.enum(STATEMENTS),
  /** Canonical key (FinancialMetric) when FINN maps the row; otherwise the source's own row key. */
  metric: z.string(),
  /** The row label as the source shows it. */
  label: z.string(),
  basis: z.enum(["consolidated", "standalone"]),
  period: z.object({ key: z.string(), label: z.string(), end: isoDate.optional() }),
  value: z.number().nullable(),
  unit: z.enum(UNITS),
  source: SourceRefSchema,
});
export type PeriodValue = z.infer<typeof PeriodValueSchema>;

/** One statement as columns (periods) × rows (line items), values in the stated units. */
export const StatementTableSchema = z.object({
  periods: z.array(z.object({ key: z.string(), label: z.string() })),
  rows: z.record(z.string(), z.array(z.number().nullable())),
  order: z.array(z.string()),
});
export type StatementTable = z.infer<typeof StatementTableSchema>;

/** What the analysis code needs: one company's statements on one basis. */
export type StatementSet = {
  symbol: string;
  name: string;
  basis: "consolidated" | "standalone";
  isLender: boolean;
  /** "₹ crore" or "₹ lakh". */
  units: string;
  quarters: StatementTable;
  annual: StatementTable;
  balanceSheet: StatementTable;
  cashFlow: StatementTable;
  ratios: StatementTable;
};

// ---- Primary documents -----------------------------------------------------------------------

export const PRIMARY_SOURCE_KINDS = ["annual_report", "transcript", "presentation", "recording", "credit_rating", "filing", "ir_website"] as const;

export const PrimarySourceSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  kind: z.enum(PRIMARY_SOURCE_KINDS),
  title: z.string(),
  url: z.url(),
  /** Fiscal period covered, when known ("FY26", "Q1 FY27"). */
  period: z.string().optional(),
  /** Publication year, month or date ("2026", "2026-08", "2026-10-27"). */
  date: z.string().optional(),
  /** Who hosts the file. */
  host: z.enum(["BSE", "NSE", "company", "other"]),
  /** The page or feed that listed this document (discovery is not evidence; the document is). */
  discoveredVia: SourceRefSchema,
  retrieval: z.object({
    status: z.enum(["not_fetched", "ok", "failed"]),
    checkedAt: isoDateTime.optional(),
    pages: z.number().int().optional(),
    textLayer: z.boolean().optional(),
    error: z.string().optional(),
  }),
});
export type PrimarySource = z.infer<typeof PrimarySourceSchema>;

export type CompanyFundamentals = StatementSet & {
  /** The statements page, for citations. */
  url: string;
  topRatios: { name: string; value: string }[];
  company: Company;
  documents: PrimarySource[];
  source: SourceRef;
  issues: ExtractionIssue[];
};

// ---- Research claims -------------------------------------------------------------------------

export const CitationSchema = z.object({
  sourceId: z.string(),
  page: z.number().int().positive().optional(),
  /** A named table or a detected document section. */
  section: z.string().optional(),
  /** Transcript speaker, when the evidence is a spoken passage. */
  speaker: z.string().optional(),
  /** A short verbatim excerpt of the evidence, present only when FINN located it in the document. */
  excerpt: z.string().optional(),
  /** The unit the located figure is stated in on that page ("₹ million"), when it differs from the claim's ₹ crore. */
  unit: z.string().optional(),
  /** page: located on a page · section: a named table · document: the document as a whole (not located). */
  level: z.enum(["page", "section", "document"]).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/** A reported figure a claim rests on, so it can be traced to a primary document. */
export const FigureSchema = z.object({
  metric: z.enum(["revenue", "pat", "pbt", "ebitda", "cfo"]),
  /** Fiscal year (FY26 = 2026). */
  fy: z.number().int(),
  /** Quarter-end date for a quarterly figure ("2026-06-30"); absent for a full-year figure. */
  quarter: z.string().optional(),
  /** ₹ crore, as the standardised table states it. */
  value: z.number(),
});
export type Figure = z.infer<typeof FigureSchema>;

/** A computed statement about a company. Uncited claims are invalid by construction. */
export const ResearchClaimSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  tone: z.enum(["positive", "negative", "neutral"]),
  period: z.string().optional(),
  citations: z.array(CitationSchema).min(1),
  figures: z.array(FigureSchema).optional(),
});
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;

// ---- Alert rules -----------------------------------------------------------------------------

export const AlertRuleSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.literal("price-move"), kind: z.literal("price_move"), enabled: z.boolean(), thresholdPct: z.number().min(0.5).max(50) }),
  z.object({
    id: z.literal("volume-spike"),
    kind: z.literal("volume_spike"),
    enabled: z.boolean(),
    multiple: z.number().min(1.1).max(20),
    lookbackSessions: z.number().int().min(5).max(60),
  }),
  z.object({ id: z.literal("week52"), kind: z.literal("week52_extreme"), enabled: z.boolean() }),
  z.object({ id: z.string().startsWith("filing:"), kind: z.literal("filing_category"), enabled: z.boolean(), category: z.string() }),
]);
export type AlertRule = z.infer<typeof AlertRuleSchema>;

// ---- Provider health -------------------------------------------------------------------------

export const PROVIDER_KINDS = ["prices", "announcements", "fundamentals", "documents", "directory"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const ProviderHealthSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  /** ok: last call succeeded · degraded: served a fallback or had extraction issues · down: last call failed · idle: not called yet. */
  status: z.enum(["ok", "degraded", "down", "idle"]),
  calls: z.number().int(),
  failures: z.number().int(),
  lastSuccessAt: isoDateTime.optional(),
  lastFailureAt: isoDateTime.optional(),
  lastError: z.string().optional(),
  lastLatencyMs: z.number().optional(),
  /** Why the last successful answer is flagged (a stale copy, too few sessions). */
  degradedBecause: z.string().optional(),
  issues: z.array(ExtractionIssueSchema),
  /** Standing caveats: terms, robots.txt, coverage limits. */
  note: z.string().optional(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
