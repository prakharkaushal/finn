import { rulesFromSettings } from "@/lib/data/rules";
import { DEFAULT_ALERT_CATEGORIES } from "@/lib/domain/categories";
import { change } from "@/lib/domain/numbers";
import { DEFAULT_THRESHOLDS, type MarketSignal } from "@/lib/domain/signals";
import type { FilingItem, InboxResponse, MarketItem, MaterialityBreakdown } from "@/lib/inbox/types";
import type { ResultsResponse } from "@/components/inbox/results";

/**
 * Sample fixtures for the design-review gallery (/dev/states) only. Production code never
 * imports this file. Items are modelled on real filings FINN captured on 27 Oct 2026 and are
 * labelled "Sample" everywhere they render.
 */

const AS_OF = "2026-10-27T22:16:00.000Z";
const NSE = "https://nsearchives.nseindia.com/corporate";

/** A sample score breakdown: the category weight, plus the alert-list bonus when the sample is triggered. */
function sampleMateriality(score: number, triggered: boolean, label: string): MaterialityBreakdown {
  const components: MaterialityBreakdown["components"] = triggered
    ? [{ feature: "category", points: score - 10, label }, { feature: "relevance", points: 10, label: "On your alert list (sample)" }]
    : [{ feature: "category", points: score, label }];
  return { components, confidence: { level: "high", reasons: ["Sample item for design review"] } };
}

function filing(p: Partial<FilingItem> & Pick<FilingItem, "id" | "symbol" | "companyName" | "ts" | "category" | "subtype" | "headline" | "tier">): FilingItem {
  const score = p.score ?? (p.tier === "attention" ? 80 : p.tier === "look" ? 45 : 5);
  const triggered = p.triggered ?? p.tier === "attention";
  return {
    kind: "filing",
    why: null,
    summary: null,
    facts: [],
    score,
    triggered,
    reasons: [],
    materiality: sampleMateriality(score, triggered, p.reasons?.[0] ?? p.headline),
    primary: { title: "Filing", url: `${NSE}/${p.symbol}_SAMPLE.pdf`, ts: p.ts, docType: "pdf", exchange: "NSE" },
    related: [],
    via: "sample",
    provenance: "sample",
    asOf: AS_OF,
    ...p,
  };
}

const spark = (start: number, drift: number) => Array.from({ length: 30 }, (_, i) => +(start + drift * i + Math.sin(i / 2) * start * 0.01).toFixed(2));

const cipla: MarketSignal = {
  date: "2026-10-27",
  close: 1350,
  prevClose: 1355,
  changePct: -0.369,
  volume: 5_742_000,
  avgVolume: 1_376_500,
  volumeRatio: 4.17,
  spark: spark(1410, -2),
  hits: [{ id: "volume", label: "Volume 4.2× 20-day average (rule: 2×)" }],
  excludedPartialSession: false,
};

const items: (FilingItem | MarketItem)[] = [
  filing({
    id: "HOMEFIRST:results:2026-10-27",
    symbol: "HOMEFIRST",
    companyName: "Home First Finance Company India",
    ts: "2026-10-27T18:03:00+05:30",
    category: "results",
    subtype: "results_filed",
    headline: "Q2 FY27 results",
    tier: "attention",
    why: "Quarterly numbers are out; the comparison with last quarter and last year is below.",
    reasons: ["Results filed", "On your alert list"],
    results: { periodEnd: "2026-09-30", quarterLabel: "Q2 FY27" },
    related: [
      { title: "Investor Presentation", url: `${NSE}/HOMEFIRST_SAMPLE_deck.pdf`, ts: "2026-10-27T18:01:00+05:30", docType: "pdf", exchange: "NSE" },
      { title: "Press Release", url: `${NSE}/HOMEFIRST_SAMPLE_press.pdf`, ts: "2026-10-27T18:03:00+05:30", docType: "pdf", exchange: "NSE" },
    ],
  }),
  filing({
    id: "HOMEFIRST:management_change:2026-10-27",
    symbol: "HOMEFIRST",
    companyName: "Home First Finance Company India",
    ts: "2026-10-27T19:18:00+05:30",
    category: "management_change",
    subtype: "mgmt_key",
    headline: "CFO appointed: Ms. Rinkoo Somani",
    tier: "attention",
    why: "New CFO from 27 Oct. The company's own profile of the appointee is below.",
    reasons: ["Key role: Chief Financial Officer", "On your alert list"],
    facts: [{ label: "CFO effective", value: "27 Oct" }],
    xbrl: {
      symbol: "HOMEFIRST",
      details: {
        kind: "management",
        people: [
          {
            name: "Ms. Rinkoo Somani",
            changeType: "Appointment",
            role: "Chief Financial Officer",
            roleCategory: "Key Managerial Personnel",
            effectiveDate: "2026-10-27",
            briefProfile:
              "Ms. Rinkoo Somani is a Chartered Accountant with over 25 years of experience in finance, treasury, regulatory compliance, capital planning and financial controls. She has held senior leadership positions at HDFC Limited, HDFC Bank, IDFC Limited and IDFC FIRST Bank, including Interim CFO of IDFC Limited.",
          },
        ],
      },
    },
  }),
  {
    kind: "market",
    id: "CIPLA:market:2026-10-27",
    symbol: "CIPLA",
    companyName: "Cipla",
    ts: "2026-10-27T15:30:00+05:30",
    headline: "Volume 4.2× average",
    why: "In the session of 27 Oct it traded above your 2× 20-day volume rule.",
    score: 76,
    tier: "attention",
    triggered: true,
    reasons: ["Volume 4.2× 20-day average (rule: 2×)"],
    materiality: {
      components: [
        { feature: "category", points: 70, label: "One of your price or volume rules fired" },
        { feature: "magnitude", points: 6, label: "Volume 4.2× its 20-day average (2.1× your 2× rule)" },
      ],
      confidence: { level: "high", reasons: ["Sample item for design review"] },
    },
    signal: cipla,
    provenance: "sample",
    asOf: AS_OF,
    priceSource: { label: "Yahoo Finance chart (end of day)", adjustment: "split-adjusted" },
  },
  filing({
    id: "HCLTECH:M&A:2026-10-27",
    symbol: "HCLTECH",
    companyName: "HCL Technologies",
    ts: "2026-10-27T12:08:00+05:30",
    category: "M&A",
    subtype: "ma_update",
    headline: "Acquisition update: transaction completed",
    tier: "attention",
    why: "An earlier deal is now complete (₹98.20 cr).",
    reasons: ["Deal update: transaction completed", "On your alert list"],
    facts: [
      { label: "Amount", value: "₹98.20 cr" },
      { label: "Completed", value: "26 Oct" },
    ],
  }),
  filing({
    id: "LT:press_release:2026-10-27",
    symbol: "LT",
    companyName: "Larsen & Toubro",
    ts: "2026-10-27T12:19:00+05:30",
    category: "press_release",
    subtype: "order_win",
    headline: "Order win",
    tier: "look",
    why: "New orders add to revenue visibility; the value is in the filing.",
    reasons: ["Order win"],
    facts: [
      { label: "From", value: "Dhaka Mass Transit Company Limited" },
      { label: "Related party", value: "No" },
    ],
  }),
  filing({
    id: "ETERNAL:earnings_call:2026-10-27",
    symbol: "ETERNAL",
    companyName: "Eternal",
    ts: "2026-10-27T17:03:00+05:30",
    category: "earnings_call",
    subtype: "call_transcript",
    headline: "Earnings-call transcript",
    tier: "look",
    why: "Management's own words on the quarter — FINN uses these to check guidance.",
    reasons: ["Earnings-call transcript"],
  }),
  filing({
    id: "LT:unclassified-esop:2026-10-27",
    symbol: "LT",
    companyName: "Larsen & Toubro",
    ts: "2026-10-27T13:15:00+05:30",
    category: "unclassified",
    subtype: "esop",
    headline: "ESOP share allotment",
    tier: "routine",
    reasons: ["ESOP allotment (routine)"],
  }),
  filing({
    id: "POLYCAB:unclassified-routine:2026-10-27",
    symbol: "POLYCAB",
    companyName: "Polycab India",
    ts: "2026-10-27T10:02:00+05:30",
    category: "unclassified",
    subtype: "routine",
    headline: "Certificate under SEBI (Depositories and Participants) Regulations",
    tier: "routine",
    reasons: ["Routine compliance filing"],
  }),
];

export const SAMPLE_NOTICE = "These items are modelled on real filings FINN captured on 27 Oct 2026. They are for design review only — not live, and not a recommendation.";

export const sampleInbox: InboxResponse = {
  dataMode: "sample",
  generatedAt: AS_OF,
  window: { key: "24h", from: "2026-10-26T22:16:00.000Z", to: AS_OF },
  items,
  counts: { attention: 4, look: 2, routine: 2 },
  upcoming: [{ symbol: "RELIANCE", companyName: "Reliance Industries", date: "2026-10-30", label: "Results", url: `${NSE}/RELIANCE_SAMPLE_intimation.pdf` }],
  pulse: [
    { symbol: "BHARTIARTL", name: "Bharti Airtel", signal: { ...cipla, changePct: 3.2, hits: [], spark: spark(1880, 3) }, provenance: "sample", asOf: AS_OF },
    { symbol: "CIPLA", name: "Cipla", signal: cipla, provenance: "sample", asOf: AS_OF },
    { symbol: "HDFCBANK", name: "HDFC Bank", signal: { ...cipla, changePct: -1.1, hits: [], spark: spark(720, -1.2) }, provenance: "sample", asOf: AS_OF },
  ],
  coverage: { notes: ["Sample coverage note — NSE corporate announcements (nseindia.com): 20 Oct, 00:00 → 27 Oct, 22:16, 20 of 20 companies"], gaps: [] },
  sources: [
    { id: "nse-api", role: "announcements", label: "NSE corporate announcements (nseindia.com)", provenance: "sample", asOf: AS_OF },
    { id: "prices", role: "prices", label: "End-of-day prices", provenance: "sample", asOf: AS_OF },
  ],
  unknownSymbols: [],
  rules: rulesFromSettings(DEFAULT_THRESHOLDS, DEFAULT_ALERT_CATEGORIES),
};

/** The same inbox as it looks when sources degrade: live listings down, prices from the snapshot. */
export const degradedInbox: InboxResponse = {
  ...sampleInbox,
  sources: [
    { id: "nse-api", role: "announcements", label: "NSE corporate announcements (nseindia.com)", provenance: "error", detail: "NSE announcements API refused the request (HTTP 403); FINN does not retry a refusal" },
    { id: "nse-rss", role: "announcements", label: "NSE announcements RSS (official)", provenance: "error", detail: "NSE announcements feed unreachable (fetch failed)" },
    { id: "snapshot-filings", role: "announcements", label: "Committed snapshot: filings archive", provenance: "snapshot", asOf: AS_OF },
    { id: "prices", role: "prices", label: "End-of-day prices", provenance: "snapshot", asOf: AS_OF, detail: "20 from Committed snapshot: end-of-day prices (snapshot)" },
  ],
  unknownSymbols: ["TATAMOTORS"],
};

export const quietInbox: InboxResponse = { ...sampleInbox, items: [], counts: { attention: 0, look: 0, routine: 0 }, upcoming: [] };

const metric = (key: "revenue" | "nii" | "pbt" | "pat", label: string, current: number, prevQuarter: number, yearAgo: number, definition: string) => ({
  key,
  label,
  status: "ok" as const,
  current,
  prevQuarter,
  yearAgo,
  qoq: change(current, prevQuarter),
  yoy: change(current, yearAgo),
  definition,
  sourceRow: key === "nii" ? "revenue − interest" : key === "revenue" ? "revenue" : key === "pbt" ? "profit before tax" : "net profit",
});

export const sampleResults: Record<string, ResultsResponse> = {
  "HOMEFIRST:2026-09-30": {
    snapshot: {
      status: "ok",
      quarter: { end: "2026-09-30", fy: 2027, q: 2, label: "Q2 FY27" },
      basis: "standalone",
      isLender: true,
      units: "₹ crore",
      metrics: [
        metric("revenue", "Revenue", 567, 538, 477, "Revenue from operations"),
        metric("nii", "NII", 342, 330, 274, "Net interest income: revenue − interest expended."),
        {
          key: "ebitda",
          label: "EBITDA",
          status: "not-applicable",
          current: null,
          prevQuarter: null,
          yearAgo: null,
          qoq: { kind: "na", reason: "missing" },
          yoy: { kind: "na", reason: "missing" },
          definition: "Not meaningful for a lender, whose interest cost is its cost of goods; NII is shown instead.",
          sourceRow: null,
        },
        metric("pbt", "PBT", 222, 208, 173, "Profit before tax"),
        metric("pat", "PAT", 170, 160, 132, "Profit after tax (net profit)"),
      ],
      margins: [{ label: "PAT margin", current: 30.0, qoqBps: 26, yoyBps: 231 }],
      comparedWith: { prevQuarter: "2026-06-30", yearAgo: "2025-09-30" },
    },
    source: { label: "screener.in quarterly table (sample)", url: "https://www.screener.in/company/HOMEFIRST/#quarters" },
    provenance: "sample",
    fetchedAt: AS_OF,
  },
};
