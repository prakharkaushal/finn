import type { AnnouncementOutcome, ProviderSet } from "@/lib/data/service";
import { rulesFromSettings } from "@/lib/data/rules";
import type { CompanyFundamentals, DataMode, PriceSeries, SourceRef } from "@/lib/data/schema";
import { dataNow, getAnnouncements, getDirectory, getFundamentals, getPrices, providerSet } from "@/lib/data/service";
import { type Category } from "@/lib/domain/categories";
import { classify } from "@/lib/domain/classify";
import { resultsPeriodEnd } from "@/lib/domain/extract";
import { marketMateriality, type Confidence } from "@/lib/domain/materiality";
import { displayName } from "@/lib/domain/names";
import { resultsSnapshot, ttmRevenueCr } from "@/lib/domain/results";
import { computeSignal, istDate, type MarketSignal, type Thresholds } from "@/lib/domain/signals";
import { covered, gapsWithin, mergeIntervals, type ArchivedAnnouncement, type Interval } from "@/lib/inbox/archive";
import { buildFilingItems, sortItems } from "@/lib/inbox/build";
import { WINDOWS, type FilingItem, type InboxResponse, type MarketItem, type PulseRow, type ResultsAttachment, type SourceProvenance, type SourceStatus, type WindowKey } from "@/lib/inbox/types";
import { marketHeadline, marketWhy } from "@/lib/inbox/why";
import { loadXbrl } from "@/lib/sources/xbrl";

export type InboxRequest = {
  symbols: string[];
  windowKey: WindowKey;
  thresholds: Thresholds;
  alertCategories: Category[];
};

/** XBRL is fetched only where it changes the card: people, deals, orders, capital, regulators. */
const XBRL_WORTH_READING =
  /change in director|change in management|resignation|appointment|cessation|acquisition|restructuring|amalgamation|merger|bagging|order|fund raising|alteration of capital|actions initiated|orders passed|insolvency/i;
const MAX_XBRL_FETCHES = 40;
/** Statements are fetched only for companies whose cards need numbers (results, orders, deals). */
const MAX_FUNDAMENTALS = 12;

function fmtIst(ms: number) {
  return new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
}

/** The least trustworthy label among a set of sources: demo > snapshot > stale > live > cache. */
function weakest(modes: DataMode[]): SourceProvenance {
  for (const m of ["demo", "snapshot", "stale"] as const) if (modes.includes(m)) return m;
  return modes.includes("live") ? "live" : "cache";
}

export type MergedListings = {
  announcements: ArchivedAnnouncement[];
  sourceById: Map<string, SourceRef>;
  coverageBySymbol: Map<string, Interval[]>;
};

/**
 * Every listing's filings, deduplicated by document URL — the same filing seen by the NSE
 * listing, the RSS feed and the archive is one filing. Earlier providers win (live before
 * archive); structured XBRL from any copy is kept. BSE items only fill time NSE coverage does
 * not reach, so nothing is counted twice. Items are copied: originals live in shared caches.
 */
export function mergeListings(outcomes: AnnouncementOutcome[], symbols: string[]): MergedListings {
  const wanted = new Set(symbols);
  const byId = new Map<string, ArchivedAnnouncement>();
  const sourceById = new Map<string, SourceRef>();
  for (const o of outcomes) {
    if (!o.ok) continue;
    for (const { source, ...a } of o.batch.items) {
      if (!a.symbol || !wanted.has(a.symbol)) continue;
      const prev = byId.get(a.id);
      if (prev) {
        if (!prev.xbrl && a.xbrl) prev.xbrl = a.xbrl;
        continue;
      }
      byId.set(a.id, { ...a });
      sourceById.set(a.id, source);
    }
  }
  const coverageBySymbol = new Map<string, Interval[]>(
    symbols.map((s) => [s, mergeIntervals(outcomes.flatMap((o) => (o.ok ? [...(o.batch.coverage[s] ?? []), ...(o.batch.coverage["*"] ?? [])] : [])))]),
  );
  const announcements = [...byId.values()].filter((a) => a.exchange === "NSE" || !covered(Date.parse(a.ts), coverageBySymbol.get(a.symbol!) ?? []));
  return { announcements, sourceById, coverageBySymbol };
}

const confidenceOf = (mode: DataMode): Confidence =>
  mode === "stale" || mode === "snapshot"
    ? { level: "medium", reasons: ["Prices were served from an older copy"] }
    : { level: "high", reasons: ["End-of-day prices from the source"] };

/** `set` and `now` are injectable so the whole pipeline can run on fixtures in tests. */
export async function getInbox(req: InboxRequest, opts: { now?: number; set?: ProviderSet } = {}): Promise<InboxResponse> {
  const set = opts.set ?? providerSet();
  const now = opts.now ?? (await dataNow(set));
  const windowFrom = now - WINDOWS[req.windowKey] * 3_600_000;
  const directory = await getDirectory(undefined, set);
  const { index } = directory;

  const known = req.symbols.filter((s) => index.bySymbol.has(s));
  const unknownSymbols = req.symbols.filter((s) => !index.bySymbol.has(s));
  const names = new Map(known.map((s) => [s, displayName(index.bySymbol.get(s)!.name)]));

  const [outcomes, seriesResults] = await Promise.all([
    getAnnouncements({ symbols: known, from: windowFrom, to: now, directory }, undefined, set),
    Promise.allSettled(known.map((code) => getPrices({ exchange: "NSE", code }, undefined, set))),
  ]);
  const { announcements, sourceById, coverageBySymbol } = mergeListings(outcomes, known);

  // 1. Structured XBRL for material filings in the window (immutable, cached forever).
  //    Demo mode never touches the network: archived items already carry their XBRL.
  const toEnrich =
    set.mode === "live"
      ? announcements.filter((a) => a.docType === "xbrl" && !a.xbrl && Date.parse(a.ts) >= windowFrom && XBRL_WORTH_READING.test(a.subject)).slice(0, MAX_XBRL_FETCHES)
      : [];
  let xbrlFailures = 0;
  await Promise.all(
    toEnrich.map(async (a) => {
      try {
        a.xbrl = (await loadXbrl(a.url)).value;
      } catch {
        xbrlFailures++;
      }
    }),
  );

  // 2. End-of-day price/volume rules (first, so filing cards can mention a move in the same company).
  const priceLabel = new Map(set.prices.map((p) => [p.id, p.label]));
  const signals = new Map<string, { series: PriceSeries; signal: MarketSignal | null; label: string }>();
  const pulse: PulseRow[] = [];
  const bySource = new Map<string, number>();
  const modes: DataMode[] = [];
  let priceFailures = 0;
  let oldestAsOf: string | undefined;
  known.forEach((symbol, i) => {
    const r = seriesResults[i];
    if (r.status === "rejected") {
      priceFailures++;
      pulse.push({ symbol, name: names.get(symbol)!, signal: null, provenance: "error" });
      return;
    }
    const series = r.value;
    const label = priceLabel.get(series.source.provider) ?? series.source.provider;
    const tally = `${label} (${series.source.mode})`;
    bySource.set(tally, (bySource.get(tally) ?? 0) + 1);
    modes.push(series.source.mode);
    if (!oldestAsOf || series.source.retrievedAt < oldestAsOf) oldestAsOf = series.source.retrievedAt;
    const signal = computeSignal(series.bars, req.thresholds, { sessionOpen: series.sessionOpen, now });
    signals.set(symbol, { series, signal, label });
    pulse.push({ symbol, name: names.get(symbol)!, signal, provenance: series.source.mode, asOf: series.source.retrievedAt });
  });
  const marketMoves = new Map<string, { date: string; label: string }[]>();
  for (const [symbol, { signal }] of signals) {
    if (signal?.hits.length && Date.parse(`${signal.date}T15:30:00+05:30`) >= windowFrom) marketMoves.set(symbol, [{ date: signal.date, label: marketHeadline(signal) }]);
  }

  // 3. Statements for cards that need numbers: results (QoQ/YoY) and orders or deals (size vs revenue).
  const results = new Map<string, ResultsAttachment>();
  const ttmRevenue = new Map<string, number | null>();
  const needs = new Map<string, Set<string>>();
  for (const a of announcements) {
    if (!a.symbol || Date.parse(a.ts) < windowFrom) continue;
    const c = classify(a.subject, a.description, a.xbrl?.details);
    if (c.subtype === "results_filed") needs.set(a.symbol, (needs.get(a.symbol) ?? new Set()).add(resultsPeriodEnd(a.description, a.ts)));
    else if (c.subtype === "order_win" || c.category === "M&A") needs.set(a.symbol, needs.get(a.symbol) ?? new Set());
  }
  const wantedFundamentals = [...needs.keys()].slice(0, MAX_FUNDAMENTALS);
  const fundamentals = await Promise.allSettled(wantedFundamentals.map((s) => getFundamentals(s, undefined, set)));
  wantedFundamentals.forEach((symbol, i) => {
    const r = fundamentals[i];
    const f: CompanyFundamentals | null = r.status === "fulfilled" ? r.value : null;
    ttmRevenue.set(symbol, f ? ttmRevenueCr(f) : null);
    for (const periodEnd of needs.get(symbol) ?? []) {
      results.set(
        `${symbol}:${periodEnd}`,
        f
          ? {
              snapshot: resultsSnapshot(f, periodEnd),
              source: { label: "screener.in quarterly table (compiled from company filings)", url: `${f.url}#quarters`, provenance: f.source.mode, fetchedAt: f.source.retrievedAt },
            }
          : { snapshot: null, error: r.status === "rejected" && r.reason instanceof Error ? r.reason.message : "Statements unavailable" },
      );
    }
  });

  const { items: filingItems, upcoming } = buildFilingItems({
    announcements,
    names,
    alertCategories: new Set(req.alertCategories),
    windowFrom,
    now,
    sourceOf: (a) => {
      const s = sourceById.get(a.id);
      return { provenance: s?.mode ?? "snapshot", asOf: s?.retrievedAt ?? new Date(now).toISOString() };
    },
    context: { results, ttmRevenue, marketMoves },
  });

  // 4. One alert per company per session, however many of the price/volume rules fired.
  const marketItems: MarketItem[] = [];
  for (const [symbol, { series, signal, label }] of signals) {
    if (!signal?.hits.length) continue;
    const session = `${signal.date}T15:30:00+05:30`;
    if (Date.parse(session) < windowFrom) continue;
    const explaining = filingItems.find((f: FilingItem) => f.symbol === symbol && f.score >= 30 && istDate(Date.parse(f.ts)) <= signal.date && Date.parse(f.ts) >= Date.parse(session) - 4 * 86_400_000);
    const m = marketMateriality(signal, req.thresholds, {
      ageHours: (now - Date.parse(session)) / 3_600_000,
      corroboration: explaining ? `A filing may explain it: ${explaining.headline} (${new Date(explaining.ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })})` : null,
      confidence: confidenceOf(series.source.mode),
    });
    marketItems.push({
      kind: "market",
      id: `${symbol}:market:${signal.date}`,
      symbol,
      companyName: names.get(symbol)!,
      ts: session,
      headline: marketHeadline(signal),
      why: marketWhy(signal, req.thresholds),
      score: m.score,
      tier: m.tier,
      triggered: true,
      reasons: signal.hits.map((h) => h.label),
      materiality: { components: m.components, confidence: m.confidence },
      signal,
      provenance: series.source.mode,
      asOf: series.source.retrievedAt,
      priceSource: { label, adjustment: series.adjustment.close },
    });
  }

  const items = sortItems([...filingItems, ...marketItems]);
  const counts = { attention: 0, look: 0, routine: 0 };
  for (const it of items) counts[it.tier]++;

  // 5. Say plainly what the window covers and where it does not.
  const union = mergeIntervals([...coverageBySymbol.values()].flat());
  const gaps = gapsWithin(windowFrom, now, union)
    .filter((g) => g.to - g.from > 30 * 60_000)
    .map((g) => `${fmtIst(g.from)} – ${fmtIst(g.to)}`);
  const notes: string[] = [];
  for (const o of outcomes) {
    if (!o.ok) continue;
    const span = mergeIntervals(Object.values(o.batch.coverage).flat());
    if (!span.length) continue;
    const reach = o.batch.coverage["*"] ? "all companies" : `${known.filter((s) => o.batch.coverage[s]?.length).length} of ${known.length} companies`;
    notes.push(`${o.provider.label}: ${fmtIst(span[0].from)} → ${fmtIst(span.at(-1)!.to)}, ${reach}`);
  }
  if (gaps.length) notes.push("Gaps in NSE coverage are filled from BSE (latest 5 filings per company via screener.in) where available");
  if (needs.size > MAX_FUNDAMENTALS) notes.push(`Numbers were looked up for the first ${MAX_FUNDAMENTALS} companies with results, orders or deals; other cards fetch theirs when opened`);

  const wanted = new Set(known);
  const sources: SourceStatus[] = [
    ...outcomes.map((o): SourceStatus => {
      if (!o.ok) return { id: o.provider.id, role: "announcements", label: o.provider.label, provenance: "error", detail: o.error };
      const n = o.batch.items.filter((a) => a.symbol && wanted.has(a.symbol)).length;
      const issues = o.batch.issues.length ? ` · ${o.batch.issues.length} row${o.batch.issues.length === 1 ? "" : "s"} unreadable` : "";
      return { id: o.provider.id, role: "announcements", label: o.provider.label, provenance: o.batch.source.mode, asOf: o.batch.source.retrievedAt, detail: `${n} filings for your companies${issues}` };
    }),
    {
      id: "prices",
      role: "prices",
      label: "End-of-day prices",
      provenance: known.length > 0 && priceFailures === known.length ? "error" : weakest(modes),
      asOf: oldestAsOf,
      detail: [...[...bySource].map(([k, n]) => `${n} from ${k}`), ...(priceFailures ? [`${priceFailures} failed`] : [])].join(" · "),
    },
    { id: "directory", role: "reference", label: "NSE equity master list", provenance: directory.source.mode, asOf: directory.source.retrievedAt },
  ];
  if (wantedFundamentals.length) {
    const ok = fundamentals.filter((r) => r.status === "fulfilled").length;
    const first = fundamentals.find((r): r is PromiseFulfilledResult<CompanyFundamentals> => r.status === "fulfilled");
    sources.push({
      id: "statements",
      role: "enrichment",
      label: "Statements for results and order sizes",
      provenance: ok === 0 ? "error" : (first?.value.source.mode ?? "live"),
      asOf: first?.value.source.retrievedAt,
      detail: `${ok} of ${wantedFundamentals.length} companies read`,
    });
  }
  if (toEnrich.length) {
    sources.push({
      id: "xbrl",
      role: "enrichment",
      label: "Reg-30 XBRL disclosures (NSE)",
      provenance: xbrlFailures === toEnrich.length ? "error" : "live",
      detail: `${toEnrich.length - xbrlFailures} of ${toEnrich.length} read${xbrlFailures ? "; cards for the rest show the filing only" : ""}`,
    });
  }

  return {
    dataMode: set.mode,
    generatedAt: new Date(now).toISOString(),
    window: { key: req.windowKey, from: new Date(windowFrom).toISOString(), to: new Date(now).toISOString() },
    items,
    counts,
    upcoming,
    pulse,
    coverage: { notes, gaps },
    sources,
    unknownSymbols,
    rules: rulesFromSettings(req.thresholds, req.alertCategories),
  };
}
