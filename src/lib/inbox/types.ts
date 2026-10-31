import type { AlertRule, DataMode, RawAnnouncement } from "@/lib/data/schema";
import type { Category, Tier } from "@/lib/domain/categories";
import type { Confidence, ScoreComponent } from "@/lib/domain/materiality";
import type { ResultsSnapshot } from "@/lib/domain/results";
import type { MarketSignal } from "@/lib/domain/signals";
import type { DocType } from "@/lib/sources/nse-rss";
import type { XbrlDocument } from "@/lib/sources/xbrl";

/** Wire types for /api/inbox. Imported by client components, so no runtime imports here. */

export const WINDOWS = { "24h": 24, "3d": 72, "7d": 168, "30d": 720 } as const;
export type WindowKey = keyof typeof WINDOWS;

/** "sample" only ever appears in the design fixtures under src/fixtures — never from the API. */
export type ItemProvenance = DataMode | "sample";
export type SourceProvenance = DataMode | "error" | "sample";

export type FilingDoc = { title: string; url: string; ts: string; docType: DocType; exchange: "NSE" | "BSE" };

/** How the score was built (named components that sum to it) and how sure FINN is. */
export type MaterialityBreakdown = { components: ScoreComponent[]; confidence: Confidence };

/** Results numbers computed on the server, with where they came from. */
export type ResultsAttachment = {
  /** null when the statements could not be read (see error). */
  snapshot: ResultsSnapshot | null;
  source?: { label: string; url: string; provenance: ItemProvenance; fetchedAt: string };
  error?: string;
};

export type FilingItem = {
  kind: "filing";
  id: string;
  symbol: string;
  companyName: string;
  ts: string;
  category: Category;
  subtype: string;
  headline: string;
  /** One factual line on why this deserves attention; null for routine paperwork. */
  why: string | null;
  /** The exchange's own description when it says more than the subject line; null otherwise. */
  summary: string | null;
  facts: { label: string; value: string }[];
  /** Materiality score: the sum of `materiality.components` (category weight 0–100, plus or minus the rest). */
  score: number;
  tier: Tier;
  /** True when the category is on the investor's alert list and the filing is material. */
  triggered: boolean;
  reasons: string[];
  materiality: MaterialityBreakdown;
  primary: FilingDoc;
  related: FilingDoc[];
  via: RawAnnouncement["via"] | "sample";
  provenance: ItemProvenance;
  /** When the source that supplied this item was fetched (ISO). */
  asOf: string;
  xbrl?: XbrlDocument;
  /** attached: computed on the server; absent = the card fetches the numbers when opened. */
  results?: { periodEnd: string; quarterLabel: string; attached?: ResultsAttachment };
};

export type MarketItem = {
  kind: "market";
  id: string;
  symbol: string;
  companyName: string;
  ts: string;
  headline: string;
  why: string;
  score: number;
  tier: Tier;
  triggered: true;
  reasons: string[];
  materiality: MaterialityBreakdown;
  signal: MarketSignal;
  provenance: ItemProvenance;
  asOf: string;
  /** Which price source supplied the bars, and whether its closes are as traded or split-adjusted. */
  priceSource: { label: string; adjustment: "as-traded" | "split-adjusted" };
};

export type InboxItem = FilingItem | MarketItem;

export type PulseRow = {
  symbol: string;
  name: string;
  signal: MarketSignal | null;
  provenance: SourceProvenance;
  asOf?: string;
};

export type SourceStatus = {
  id: string;
  /** announcements and prices decide the inbox's overall status; listings are alternatives to each other. */
  role: "announcements" | "prices" | "reference" | "enrichment";
  label: string;
  provenance: SourceProvenance;
  asOf?: string;
  detail?: string;
};

export type Upcoming = { symbol: string; companyName: string; date: string; label: string; url: string };

export type InboxResponse = {
  /** "demo": every item comes from the committed demo dataset, replayed at its capture time. "sample" is design fixtures only. */
  dataMode: "live" | "demo" | "sample";
  generatedAt: string;
  window: { key: WindowKey; from: string; to: string };
  items: InboxItem[];
  counts: Record<Tier, number>;
  upcoming: Upcoming[];
  pulse: PulseRow[];
  coverage: { notes: string[]; gaps: string[] };
  sources: SourceStatus[];
  unknownSymbols: string[];
  /** The alert rules this response was computed with. */
  rules: AlertRule[];
};
