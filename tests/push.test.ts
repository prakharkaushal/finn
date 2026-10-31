import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { toFundamentals } from "@/lib/data/adapters/screener";
import { seedProviders } from "@/lib/data/adapters/seed";
import { NoDataError, type AnnouncementProvider, type Directory, type DirectoryProvider, type FundamentalsProvider, type ListedAnnouncement, type PriceProvider } from "@/lib/data/providers";
import type { PriceSeries, RawAnnouncement, SourceRef, StatementSet, StatementTable } from "@/lib/data/schema";
import type { ProviderSet } from "@/lib/data/service";
import { DEFAULT_ALERT_CATEGORIES, type Category } from "@/lib/domain/categories";
import { classify } from "@/lib/domain/classify";
import { dilutionMagnitude, filingMateriality, marketMateriality, resultsMagnitude, sizeVsRevenue, TRIGGER_FLOOR } from "@/lib/domain/materiality";
import { change } from "@/lib/domain/numbers";
import { resultsSnapshot, toCroreFactor, ttmRevenueCr } from "@/lib/domain/results";
import { computeSignal, DEFAULT_THRESHOLDS, type Bar } from "@/lib/domain/signals";
import { alertItems, ALERT_LOG_TTL_MS, mergeAlertLog } from "@/lib/inbox/alerts";
import { mergeListings, getInbox } from "@/lib/inbox/service";
import { marketWhy } from "@/lib/inbox/why";
import { buildIndex, parseMasterCsv } from "@/lib/sources/nse-master";
import { parseScreenerPage } from "@/lib/sources/screener";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ref = (provider: string, mode: SourceRef["mode"] = "live"): SourceRef => ({ provider, type: "exchange", url: "https://www.nseindia.com/", retrievedAt: "2026-07-25T04:30:00.000Z", mode });
const HIGH = { level: "high" as const, reasons: ["test"] };

describe("category normalisation (the reference categories)", () => {
  const cases: [string, string, Category][] = [
    ["Outcome of Board Meeting", "Cipla Limited has submitted to the Exchange, the financial results for the period ended September 30, 2026.", "results"],
    ["Acquisition", "Acquisition of 100% stake in XYZ Private Limited for a cash consideration", "M&A"],
    ["Fund Raising", "The Board approved raising funds by way of a qualified institutions placement", "fund_raise"],
    ["Change in Directors/ Key Managerial Personnel/ Senior Management/ Auditor", "Appointment of Mr. A B as Chief Financial Officer of the Company", "management_change"],
    ["Litigation / Dispute", "Update on the arbitration proceedings against a contractor", "litigation"],
    ["Disclosure under SEBI Takeover Regulations", "Disclosure under Regulation 29(2) of SEBI (SAST) Regulations", "insider_trading"],
    ["Analysts/Institutional Investor Meet/Con. Call Updates", "Transcript of the earnings conference call held on 25 July 2026", "earnings_call"],
    ["Analysts/Institutional Investor Meet/Con. Call Updates", "Schedule of meetings with institutional investors next week", "investor_meetings"],
    ["Credit Rating", "CRISIL has reaffirmed the long-term rating of the company", "credit_rating"],
    ["Dividend", "The Board declared an interim dividend of Rs 5 per share", "dividend"],
    ["Bonus issue", "Issue of bonus shares in the ratio of 1:1", "bonus_split"],
    ["Updates", "Commencement of commercial production at the new plant in Gujarat", "capex"],
    ["Press Release", "The company has launched a new product range", "press_release"],
    ["Postal Ballot", "Notice of postal ballot for the approval of shareholders", "postal_ballot"],
    ["Shareholders meeting", "Proceedings of the 45th Annual General Meeting", "agm_egm"],
    ["Disclosure of creation of encumbrance", "The promoter has created a pledge on 2% of its shares", "pledging"],
    ["Trading Window", "Closure of trading window for the quarter", "unclassified"],
  ];
  it.each(cases)("%s | %s → %s", (subject, description, category) => {
    expect(classify(subject, description).category).toBe(category);
  });

  it("covers every reference category", () => {
    expect(new Set(cases.map((c) => c[2])).size).toBe(17);
  });

  it("records what each classification rests on", () => {
    expect(classify("Credit Rating", "CRISIL has reaffirmed the rating").evidence).toBe("subject");
    expect(classify("Updates", "Commencement of commercial production at the new plant").evidence).toBe("description");
    expect(classify("Something new", "Nothing any rule recognises").evidence).toBe("none");
  });
});

describe("materiality ranking", () => {
  const results = classify("Outcome of Board Meeting", "financial results for the quarter ended June 30, 2026");
  const routine = classify("Trading Window", "Closure of trading window");
  const rank = (over: Partial<Parameters<typeof filingMateriality>[0]> = {}) =>
    filingMateriality({ classification: results, ageHours: 48, onAlertList: false, confidence: HIGH, ...over });

  it("is a sum of named components the card can show", () => {
    const m = rank({ magnitude: { points: 10, label: "Large change: PAT −52.2% YoY" }, ageHours: 2, onAlertList: true });
    expect(m.components.map((c) => c.feature)).toEqual(["category", "magnitude", "recency", "relevance"]);
    expect(m.score).toBe(m.components.reduce((s, c) => s + c.points, 0));
  });

  it("ranks a big results swing above results in line with last year", () => {
    const big = rank({ magnitude: resultsMagnitude(snapshotWith(100, 60)) });
    const flat = rank({ magnitude: resultsMagnitude(snapshotWith(100, 98)) });
    expect(big.score).toBeGreaterThan(flat.score);
  });

  it("prefers fresh filings, and marks follow-ups and low confidence down", () => {
    expect(rank({ ageHours: 2 }).score).toBeGreaterThan(rank({ ageHours: 100 }).score);
    expect(rank({ followUp: true }).score).toBeLessThan(rank().score);
    expect(rank({ confidence: { level: "low", reasons: ["No rule matched"] } }).score).toBeLessThan(rank().score);
  });

  it("triggers an alert only for material filings in watched categories", () => {
    expect(rank({ onAlertList: true })).toMatchObject({ triggered: true, tier: "attention" });
    expect(rank({ onAlertList: false }).triggered).toBe(false);
    const paperwork = filingMateriality({ classification: { ...routine, category: "results" }, ageHours: 1, onAlertList: true, confidence: HIGH });
    expect(routine.score).toBeLessThan(TRIGGER_FLOOR);
    expect(paperwork).toMatchObject({ triggered: false, tier: "routine" });
  });

  it("sizes orders, deals and dilution against the company", () => {
    expect(sizeVsRevenue("Order", 5_000_000_000, 2_000)).toMatchObject({ points: 10 });
    expect(sizeVsRevenue("Order", 600_000_000, 2_000)).toMatchObject({ points: 5 });
    expect(sizeVsRevenue("Order", 10_000_000, 2_000)).toMatchObject({ points: -5 });
    expect(sizeVsRevenue("Deal", null, 2_000)).toMatchObject({ points: 0, label: "Deal value not stated in the filing" });
    expect(dilutionMagnitude(0.03)?.points).toBe(-3);
    expect(dilutionMagnitude(6)?.points).toBe(10);
  });

  it("scores a price alert by how far past the investor's rule it went", () => {
    const sig = (changePct: number) => ({ ...signalOf(changePct), hits: [{ id: "price" as const, label: "Moved" }] });
    const small = marketMateriality(sig(-4.1), DEFAULT_THRESHOLDS, { ageHours: 18, confidence: HIGH });
    const large = marketMateriality(sig(-9), DEFAULT_THRESHOLDS, { ageHours: 18, confidence: HIGH });
    expect(large.score).toBeGreaterThan(small.score);
    expect(large.components.find((c) => c.feature === "magnitude")?.label).toMatch(/2\.3× your ±4% rule/);
  });
});

/** n weekday sessions ending on `last` (YYYY-MM-DD). */
function sessions(last: string, n: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${last}T12:00:00Z`); out.length < n; t -= 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

function bars(last: string, closes: number[], volumes: number[]): Bar[] {
  return sessions(last, closes.length).map((date, i) => ({ date, open: closes[i], high: closes[i], low: closes[i], close: closes[i], volume: volumes[i] }));
}

function signalOf(changePct: number) {
  const s = computeSignal(bars("2026-07-24", [...Array(21).fill(100), 100 * (1 + changePct / 100)], Array(22).fill(1000)), { ...DEFAULT_THRESHOLDS, pricePct: 1 }, { sessionOpen: false })!;
  return s;
}

describe("alert thresholds (end-of-day)", () => {
  const flat = Array(21).fill(100);
  const vol = Array(21).fill(1000);

  it("fires the price rule at exactly the threshold, not below it", () => {
    expect(computeSignal(bars("2026-07-24", [...flat, 104], [...vol, 1000]), DEFAULT_THRESHOLDS, { sessionOpen: false })!.hits.map((h) => h.id)).toEqual(["price"]);
    expect(computeSignal(bars("2026-07-24", [...flat, 103.99], [...vol, 1000]), DEFAULT_THRESHOLDS, { sessionOpen: false })!.hits).toEqual([]);
    expect(computeSignal(bars("2026-07-24", [...flat, 96], [...vol, 1000]), DEFAULT_THRESHOLDS, { sessionOpen: false })!.hits.map((h) => h.id)).toEqual(["price"]);
  });

  it("compares volume with the average of the previous N sessions only", () => {
    const at = computeSignal(bars("2026-07-24", [...flat, 100], [...vol, 2000]), DEFAULT_THRESHOLDS, { sessionOpen: false })!;
    expect(at).toMatchObject({ avgVolume: 1000, volumeRatio: 2 });
    expect(at.hits.map((h) => h.id)).toEqual(["volume"]);
    const below = computeSignal(bars("2026-07-24", [...flat, 100], [...vol, 1999]), DEFAULT_THRESHOLDS, { sessionOpen: false })!;
    expect(below.hits).toEqual([]);
    // A 10-session window ignores the older, quieter sessions.
    const recent = computeSignal(bars("2026-07-24", [...flat, 100], [...Array(11).fill(100), ...Array(10).fill(1000), 2000]), { ...DEFAULT_THRESHOLDS, lookback: 10 }, { sessionOpen: false })!;
    expect(recent.avgVolume).toBe(1000);
  });

  it("never judges a session that is still trading", () => {
    const today = "2026-07-24";
    const s = computeSignal(bars(today, [...flat, 90], [...vol, 50]), DEFAULT_THRESHOLDS, { sessionOpen: true, now: Date.parse(`${today}T11:00:00+05:30`) })!;
    expect(s.excludedPartialSession).toBe(true);
    expect(s.hits).toEqual([]);
  });

  it("states the rule and the comparison window in the alert", () => {
    const s = computeSignal(bars("2026-07-24", [...flat, 95], [...vol, 3000]), DEFAULT_THRESHOLDS, { sessionOpen: false })!;
    expect(marketWhy(s, DEFAULT_THRESHOLDS)).toBe("In the session of 24 Jul it moved more than your ±4% rule and traded above your 2× 20-day volume rule.");
  });
});

describe("duplicate suppression", () => {
  it("marks an alert new only the first time a device sees it", () => {
    const t0 = Date.parse("2026-07-25T10:00:00+05:30");
    const first = mergeAlertLog({}, ["CIPLA:market:2026-07-24", "CIPLA:market:2026-07-24", "RELIANCE:results:q2026-06-30"], t0);
    expect([...first.fresh]).toEqual(["CIPLA:market:2026-07-24", "RELIANCE:results:q2026-06-30"]);
    const again = mergeAlertLog(first.log, ["CIPLA:market:2026-07-24", "RELIANCE:results:q2026-06-30"], t0 + 3_600_000);
    expect(again.fresh.size).toBe(0);
    expect(again.log["CIPLA:market:2026-07-24"].firstSeenAt).toBe(new Date(t0).toISOString());
    const later = mergeAlertLog(again.log, [], t0 + ALERT_LOG_TTL_MS + 1);
    expect(Object.keys(later.log)).toEqual([]);
  });

  it("counts one filing once, whichever listings returned it", () => {
    const doc: ListedAnnouncement = { ...raw("RELIANCE", "Press Release", "x", "2026-07-24T11:00:00+05:30", "p.pdf"), source: ref("nse-api") };
    const merged = mergeListings(
      [
        { provider: fakeAnnouncements("nse-api", []), ok: true, batch: { items: [doc], coverage: {}, source: ref("nse-api"), issues: [] } },
        { provider: fakeAnnouncements("nse-rss", []), ok: true, batch: { items: [{ ...doc, source: ref("nse-rss") }], coverage: {}, source: ref("nse-rss"), issues: [] } },
      ],
      ["RELIANCE"],
    );
    expect(merged.announcements).toHaveLength(1);
    expect(merged.sourceById.get(doc.id)?.provider).toBe("nse-api");
  });

  it("drops a BSE copy inside NSE coverage, keeps it outside", () => {
    const bse = (ts: string, id: string): ListedAnnouncement => ({ ...raw("RELIANCE", "Press Release", "x", ts, id), exchange: "BSE", via: "screener", source: ref("snapshot-filings", "snapshot") });
    const cover = { RELIANCE: [{ from: Date.parse("2026-07-24T00:00:00+05:30"), to: Date.parse("2026-07-25T10:00:00+05:30") }] };
    const merged = mergeListings(
      [{ provider: fakeAnnouncements("x", []), ok: true, batch: { items: [bse("2026-07-24T12:00:00+05:30", "in.pdf"), bse("2026-07-20T12:00:00+05:30", "out.pdf")], coverage: cover, source: ref("x"), issues: [] } }],
      ["RELIANCE"],
    );
    expect(merged.announcements.map((a) => a.id)).toEqual(["https://nsearchives.nseindia.com/corporate/out.pdf"]);
  });
});

describe("results QoQ / YoY", () => {
  it("handles zero and missing denominators without dividing", () => {
    expect(change(50, 0)).toEqual({ kind: "na", reason: "zero-base" });
    expect(change(50, null)).toEqual({ kind: "na", reason: "missing" });
    expect(change(null, 50)).toEqual({ kind: "na", reason: "missing" });
    expect(change(10, -5)).toEqual({ kind: "turned_positive" });
    expect(change(-2, -5)).toMatchObject({ kind: "loss_narrowed" });
  });

  it("converts ₹ lakh to ₹ crore and says so", () => {
    const r = resultsSnapshot(companyIn("₹ lakh", { sales: [40_000, 45_000, 50_000, 52_000, 56_700], "operating profit": [4_000, 4_500, 5_000, 5_100, 6_000], "profit before tax": [3_000, 3_200, 3_500, 3_600, 4_100], "net profit": [2_000, 2_100, 2_300, 2_400, 2_800] }), "2026-06-30");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r).toMatchObject({ units: "₹ crore", convertedFrom: "₹ lakh" });
    const revenue = r.metrics.find((m) => m.key === "revenue")!;
    expect(revenue).toMatchObject({ current: 567, prevQuarter: 520, yearAgo: 400 });
    if (revenue.yoy.kind === "pct") expect(revenue.yoy.value).toBeCloseTo(41.75, 2);
    expect(toCroreFactor("₹ crore")).toBe(1);
    expect(toCroreFactor("Rs")).toBe(1e-7);
    expect(toCroreFactor("furlongs")).toBeNull();
  });

  it("reports a metric the source lacks as not found, never as a number", () => {
    const r = resultsSnapshot(companyIn("₹ crore", { sales: [400, 450, 500, 520, 567], "net profit": [20, 21, 23, 24, 28] }), "2026-06-30");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.metrics.find((m) => m.key === "ebitda")).toMatchObject({ status: "not-found", current: null, sourceRow: null });
    expect(r.metrics.find((m) => m.key === "pbt")).toMatchObject({ status: "not-found" });
    expect(r.metrics.find((m) => m.key === "pat")).toMatchObject({ status: "ok", current: 28 });
  });

  it("reports a quarter with no value as not found, and a missing comparison as n/a", () => {
    const r = resultsSnapshot(companyIn("₹ crore", { sales: [null, 450, 500, 520, 567], "net profit": [20, 21, 23, 24, null] }), "2026-06-30");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.metrics.find((m) => m.key === "pat")?.status).toBe("not-found");
    expect(r.metrics.find((m) => m.key === "revenue")).toMatchObject({ status: "ok", yoy: { kind: "na", reason: "missing" } });
  });

  it("keeps the comparison within one basis and sums the last four quarters", () => {
    const set = companyIn("₹ crore", { sales: [400, 450, 500, 520, 567] });
    const r = resultsSnapshot({ ...set, basis: "standalone" }, "2026-06-30");
    expect(r).toMatchObject({ status: "ok", basis: "standalone" });
    expect(ttmRevenueCr(set)).toBe(450 + 500 + 520 + 567);
    expect(ttmRevenueCr(companyIn("₹ crore", { sales: [400, 450, null, 520, 567] }))).toBeNull();
  });
});

// ---- End to end: the whole push pipeline on fixtures, no network -------------------------------

function raw(symbol: string, subject: string, description: string, ts: string, file: string, docType: RawAnnouncement["docType"] = "pdf"): RawAnnouncement {
  const url = `https://nsearchives.nseindia.com/corporate/${file}`;
  return { id: url, symbol, companyName: symbol, subject, description, url, docType, ts, exchange: "NSE", via: "nse-api" };
}

function fakeAnnouncements(id: string, items: RawAnnouncement[], cover = true): AnnouncementProvider {
  return {
    id,
    label: id,
    kind: "announcements",
    async recent(q) {
      const source = ref(id);
      return {
        items: items.filter((a) => q.symbols.includes(a.symbol!)).map((a) => ({ ...a, source })),
        coverage: cover ? Object.fromEntries(q.symbols.map((s) => [s, [{ from: q.from - 86_400_000, to: q.to }]])) : {},
        source,
        issues: [],
      };
    },
  };
}

const NOW = Date.parse("2026-07-25T10:00:00+05:30");
const master = parseMasterCsv(fixture("nse-equity-sample.csv"));
const directory: Directory = { companies: master, index: buildIndex(master), source: ref("test-directory") };

function pipeline(): ProviderSet {
  const filings = [
    // One results event whose documents straddle midnight, plus its deck.
    raw("RELIANCE", "Outcome of Board Meeting", "Reliance Industries Limited has submitted the financial results for the quarter ended June 30, 2026.", "2026-07-24T23:55:00+05:30", "RIL_results.pdf"),
    raw("RELIANCE", "Financial Result Updates", "Financial results for the quarter ended June 30, 2026", "2026-07-25T00:05:00+05:30", "RIL_results.xml", "xbrl"),
    raw("RELIANCE", "Investor Presentation", "Investor presentation on the results", "2026-07-25T00:20:00+05:30", "RIL_deck.pdf"),
    raw("CIPLA", "Press Release", "Cipla receives a warning letter for its Goa facility", "2026-07-24T11:00:00+05:30", "CIPLA_press.pdf"),
    raw("CIPLA", "Change in Directors/ Key Managerial Personnel/ Senior Management/ Auditor", "Appointment of Mr. A B as Chief Financial Officer of the Company", "2026-07-25T09:00:00+05:30", "CIPLA_cfo.pdf"),
    raw("CIPLA", "Trading Window", "Closure of trading window", "2026-07-24T18:00:00+05:30", "CIPLA_tw.pdf"),
    raw("CIPLA", "Dividend", "Final dividend of Rs 13 per share", "2026-07-20T15:00:00+05:30", "CIPLA_div.pdf"),
  ];
  const series = (code: string, closes: number[], volumes: number[]): PriceSeries => ({
    instrument: { exchange: "NSE", code },
    providerSymbol: `${code}.NS`,
    currency: "INR",
    adjustment: { close: "split-adjusted", adjClose: null },
    sessionOpen: false,
    bars: bars("2026-07-24", closes, volumes).map((b) => ({ ...b, adjClose: null })),
    source: { ...ref("test-prices"), type: "market-data" },
    issues: [],
  });
  const prices: PriceProvider = {
    id: "test-prices",
    label: "Test prices",
    kind: "prices",
    supports: () => true,
    async dailySeries(i) {
      if (i.code === "CIPLA") return series("CIPLA", [...Array(24).fill(1500), 1425], [...Array(24).fill(100_000), 300_000]);
      if (i.code === "RELIANCE") return series("RELIANCE", Array(25).fill(1200), Array(25).fill(1_000_000));
      throw new NoDataError(`${i.code} not priced`);
    },
  };
  const rel = toFundamentals(parseScreenerPage(fixture("screener-reliance-consolidated.html"), "RELIANCE", "consolidated"), { ...ref("test-fundamentals"), type: "aggregator" });
  const fundamentals: FundamentalsProvider = {
    id: "test-fundamentals",
    label: "Test statements",
    kind: "fundamentals",
    async company(symbol) {
      if (symbol === "RELIANCE") return rel;
      throw new NoDataError(`${symbol} not seeded`);
    },
  };
  const dir: DirectoryProvider = { id: "test-directory", label: "Test directory", kind: "directory", load: async () => directory };
  return {
    mode: "live",
    prices: [prices],
    // Two listings return overlapping filings: the results PDF must still count once.
    announcements: [fakeAnnouncements("listing-a", filings), fakeAnnouncements("listing-b", filings.slice(0, 1))],
    fundamentals: [fundamentals],
    directory: [dir],
    seed: seedProviders("snapshot", tmpdir()),
  };
}

const request = (windowKey: "24h" | "7d") => ({ symbols: ["RELIANCE", "CIPLA"], windowKey, thresholds: DEFAULT_THRESHOLDS, alertCategories: DEFAULT_ALERT_CATEGORIES });

describe("push pipeline, end to end on fixtures", () => {
  it("bundles one results event per company and quarter, with numbers attached", async () => {
    const inbox = await getInbox(request("24h"), { now: NOW, set: pipeline() });
    const results = inbox.items.filter((i) => i.kind === "filing" && i.category === "results");
    expect(results).toHaveLength(1);
    const card = results[0];
    if (card.kind !== "filing") throw new Error("expected a filing");
    expect(card.id).toBe("RELIANCE:results:q2026-06-30");
    expect(card.related.map((d) => d.url).sort()).toEqual(["https://nsearchives.nseindia.com/corporate/RIL_deck.pdf", "https://nsearchives.nseindia.com/corporate/RIL_results.xml"]);
    const snap = card.results?.attached?.snapshot;
    if (!snap || snap.status !== "ok") throw new Error("expected computed numbers");
    expect(snap.metrics.find((m) => m.key === "revenue")).toMatchObject({ current: 309468, sourceRow: "sales" });
    expect(card.results?.attached?.source?.url).toMatch(/screener\.in\/company\/RELIANCE\/consolidated\/#quarters$/);
    expect(card.triggered).toBe(true);
  });

  it("raises one price alert per company per session and links it to the day's filing", async () => {
    const inbox = await getInbox(request("24h"), { now: NOW, set: pipeline() });
    const market = inbox.items.filter((i) => i.kind === "market");
    expect(market.map((m) => m.id)).toEqual(["CIPLA:market:2026-07-24"]);
    expect(market[0].reasons).toHaveLength(2);
    expect(market[0].materiality.components.some((c) => c.label.startsWith("A filing may explain it"))).toBe(true);
    const press = inbox.items.find((i) => i.id === "CIPLA:press_release:2026-07-24");
    expect(press?.materiality.components.some((c) => c.label.startsWith("Shares also tripped your rule"))).toBe(true);
  });

  it("ranks with explanations, keeps paperwork routine, and lists alerts once", async () => {
    const inbox = await getInbox(request("24h"), { now: NOW, set: pipeline() });
    for (const item of inbox.items) {
      const sum = item.materiality.components.reduce((s, c) => s + c.points, 0);
      expect(item.score).toBe(Math.max(0, Math.round(sum)));
    }
    const scores = inbox.items.filter((i) => i.tier === "attention").map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(inbox.items.find((i) => i.id === "CIPLA:unclassified-routine:2026-07-24")).toMatchObject({ tier: "routine", triggered: false });
    expect(inbox.items.find((i) => i.id === "CIPLA:management_change:2026-07-25")).toMatchObject({ tier: "attention", triggered: true });
    const ids = alertItems(inbox.items).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("applies the time window", async () => {
    const day = await getInbox(request("24h"), { now: NOW, set: pipeline() });
    const week = await getInbox(request("7d"), { now: NOW, set: pipeline() });
    expect(day.items.some((i) => i.id === "CIPLA:dividend:2026-07-20")).toBe(false);
    expect(week.items.some((i) => i.id === "CIPLA:dividend:2026-07-20")).toBe(true);
  });
});

// ---- helpers -------------------------------------------------------------------------------

/** A company whose last five quarters end Jun 2025 … Jun 2026, in the given unit. */
function companyIn(units: string, rows: Record<string, (number | null)[]>): StatementSet {
  const keys = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
  const table = (r: Record<string, (number | null)[]>): StatementTable => ({ periods: keys.map((key) => ({ key, label: key })), rows: r, order: Object.keys(r) });
  const empty = table({});
  return { symbol: "TEST", name: "Test Ltd", basis: "consolidated", isLender: false, units, quarters: table(rows), annual: empty, balanceSheet: empty, cashFlow: empty, ratios: empty };
}

function snapshotWith(patNow: number, patYearAgo: number) {
  return resultsSnapshot(companyIn("₹ crore", { sales: [1000, 1000, 1000, 1000, 1000], "net profit": [patYearAgo, 90, 90, 90, patNow] }), "2026-06-30");
}
