import type { Citation as CanonicalCitation, ResearchClaim, SourceRef } from "@/lib/data/schema";

/**
 * Research report wire format. Every claim carries citations; every guidance statement is
 * a verbatim quote pinned to a page. Imported by client components — types only.
 */

export type SourceDoc = {
  id: string;
  kind: "screener" | "transcript" | "annual_report" | "presentation" | "results" | "user" | "prices" | "ir_website";
  title: string;
  url: string;
  period?: string;
  /** used = FINN read it; listed = linked for the reader; failed = could not be read. */
  status: "used" | "listed" | "failed";
  note?: string;
  /** Total pages in the document. */
  pages?: number;
  /** Primary = published by the company or the exchange; screener.in and price feeds are not. */
  primary?: boolean;
  /** What FINN actually read of it. */
  coverage?: { pagesRead: number; totalPages: number; truncated: boolean };
};

export type Citation = CanonicalCitation;

/** A computed, cited statement (canonical ResearchClaim; uncited claims are invalid). */
export type Claim = ResearchClaim;

/** A verbatim passage from a primary document, with where it is. */
export type Evidence = { sourceId: string; page: number; section?: string; speaker?: string; excerpt: string };

/** Business snapshot: what the company's own documents say it does. Excerpts only; no model summary. */
export type BusinessSection = {
  status: "ok" | "no_annual_report" | "unreadable" | "skipped";
  /** Passages from the annual report describing the business. */
  overview: Evidence[];
  /** Segments the annual report names, with the passage that names them. */
  segments: { names: string[]; single: boolean; evidence: Evidence } | null;
  /** Management's own framing of the business on the latest call. */
  management: Evidence[];
  note?: string;
};

/** The brief's four outcomes for a promise, derived from the verdict and spelled out. */
export type Assessment = "met" | "partially met" | "missed" | "not comparable / insufficient evidence";

/** A number management stated about a finished quarter, checked against what was reported. */
export type ClaimCheck = {
  id: string;
  sourceId: string;
  page: number;
  speaker?: string;
  quote: string;
  metric: "revenue_growth" | "pat_growth" | "ebitda_margin";
  /** The quarter the call discussed, e.g. "Q2 FY27". */
  quarter: string;
  claimed: number;
  reported: number | null;
  status: "consistent" | "conflict" | "not comparable";
  note: string;
};

export type CasePoint = {
  theme: "growth" | "profitability" | "balance sheet" | "cash" | "working capital" | "credibility";
  /** FINN's interpretation, stated from the cited facts. */
  text: string;
  citations: Citation[];
  /** The strongest fact on the other side of the same theme, or null when none was found. */
  counter: { text: string; citations: Citation[] } | null;
};

/** Bull vs bear assembled by rules from the cited facts above — never a recommendation. */
export type CaseSection = { bull: CasePoint[]; bear: CasePoint[]; note: string };

export type Series = { labels: string[]; values: (number | null)[] };

export type GuidanceMetric =
  | "revenue_target"
  | "revenue_growth"
  | "ebitda_growth"
  | "pat_growth"
  | "ebitda_margin"
  | "ebit_margin"
  | "volume_growth"
  | "capex"
  | "other";

export type GuidancePeriod = { label: string; fy: number; scope: "FY" | "H1" | "H2" | "Q"; quarter?: 1 | 2 | 3 | 4; inferred: boolean };

export type Verdict = {
  status: "delivered" | "missed" | "beat" | "on_track" | "behind" | "pending" | "not_comparable";
  actual?: number;
  actualLabel?: string;
  basis: string;
};

export type GuidanceStatement = {
  id: string;
  sourceId: string;
  callLabel: string;
  callMonth: string;
  page: number;
  speaker?: string;
  /** "analyst" when the sentence is a questioner restating guidance ("Sir, you had guided…"). */
  voice?: "management" | "analyst";
  quote: string;
  metric?: GuidanceMetric;
  low?: number;
  high?: number;
  unit?: "%" | "INR_cr";
  period?: GuidancePeriod;
  /** True when a phrase like "mid-teens" was mapped to a range. */
  interpreted?: boolean;
  /** True when the statement is about one brand, subsidiary or segment, not the whole company. */
  segment?: boolean;
  structuredBy: "rules" | "llm" | "none";
  verdict?: Verdict;
  /** The verdict in the brief's terms, with the reason. */
  assessment?: Assessment;
  assessmentNote?: string;
};

export type Revision = {
  metric: GuidanceMetric;
  period: string;
  from: string;
  to: string;
  direction: "raised" | "cut" | "maintained";
  fromCall: string;
  toCall: string;
};

export type GuidanceSection = {
  /** skipped: transcripts exist but were not read (demo mode reads nothing from the network). */
  status: "ok" | "no_transcripts" | "unreadable" | "skipped";
  transcriptsRead: number;
  statements: GuidanceStatement[];
  revisions: Revision[];
  scorecard: Record<Verdict["status"], number>;
  note?: string;
};

export type ThesisPoint = { text: string; claimIds: string[]; statementIds: string[] };

export type ThesisSection = {
  bull: ThesisPoint[];
  bear: ThesisPoint[];
  divergences: ThesisPoint[];
  model: string;
  generatedAt: string;
  /** Points the model produced that cited nothing real; FINN drops them. */
  dropped: number;
};

export type QuarterTable = {
  labels: string[];
  keys: string[];
  revenue: (number | null)[];
  ebitda: (number | null)[];
  pat: (number | null)[];
  margin: (number | null)[];
  revenueYoY: (number | null)[];
  patYoY: (number | null)[];
};

export type ResearchReport = {
  symbol: string;
  /** The listing priced (NSE unless researched as SYMBOL.BO). Absent in older snapshots: NSE. */
  exchange?: "NSE" | "BSE";
  name: string;
  generatedAt: string;
  provenance: "live" | "snapshot" | "demo";
  basis: "consolidated" | "standalone";
  isLender: boolean;
  units: string;
  /** Where the statements were read and how fresh they were. Absent in older snapshots. */
  statementsSource?: SourceRef;
  price?: {
    close: number;
    changePct: number | null;
    date: string;
    spark: number[];
    high52: number | null;
    low52: number | null;
    /** Absent in older snapshots (which were Yahoo Finance). */
    source?: SourceRef & { label: string; adjustment: "as-traded" | "split-adjusted" };
  };
  topRatios: { name: string; value: string }[];
  headline: Claim[];
  trajectory: { years: string[]; revenue: (number | null)[]; ebitda: (number | null)[]; pat: (number | null)[]; margin: (number | null)[]; claims: Claim[] };
  quarters: QuarterTable;
  balanceSheet: { years: string[]; borrowings: (number | null)[]; equity: (number | null)[]; debtToEquity: (number | null)[]; claims: Claim[] };
  cash: { years: string[]; cfo: (number | null)[]; pat: (number | null)[]; fcf: (number | null)[]; capex?: (number | null)[]; claims: Claim[] };
  workingCapital: { years: string[]; ccc: (number | null)[]; debtorDays: (number | null)[]; inventoryDays: (number | null)[]; claims: Claim[] };
  guidance: GuidanceSection;
  thesis: ThesisSection | null;
  /** Absent in reports built before the document pipeline. */
  business?: BusinessSection;
  /** Numbers management stated about finished quarters, checked against reported ones. */
  checks?: ClaimCheck[];
  /** Rule-based bull and bear from the cited facts; the LLM thesis, when on, is separate. */
  case?: CaseSection;
  /** One plain sentence on what was read: "Read 1 annual report (FY26, 312 pages) and 4 transcripts…". */
  coverage?: string;
  sources: SourceDoc[];
  warnings: string[];
  llm: { enabled: boolean; used: boolean; fastModel?: string; reasoningModel?: string; calls: number };
};

export type ResearchEvent =
  | { type: "step"; id: string; label: string; status: "running" | "done" | "skipped" | "error"; detail?: string }
  | { type: "report"; report: ResearchReport }
  | { type: "error"; message: string };
