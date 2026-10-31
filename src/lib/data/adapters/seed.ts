import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { instrumentKey, instrumentSlug, yahooSymbol } from "@/lib/data/instrument";
import { indexFor } from "@/lib/data/adapters/nse";
import { toFundamentals } from "@/lib/data/adapters/screener";
import { NoDataError, type AnnouncementProvider, type DirectoryProvider, type FundamentalsProvider, type PriceProvider } from "@/lib/data/providers";
import type { PriceSeries, SourceRef } from "@/lib/data/schema";
import { loadArchive, nseCoverage } from "@/lib/inbox/archive";
import { readSnapshotReport } from "@/lib/research/snapshot";
import type { ResearchReport } from "@/lib/research/types";
import { SourceError } from "@/lib/net/http";
import { MASTER_SNAPSHOT_FILE, NSE_MASTER_URL, parseMasterCsv } from "@/lib/sources/nse-master";
import { NSE_RSS_URL } from "@/lib/sources/nse-rss";
import { screenerUrl, type ScreenerCompany } from "@/lib/sources/screener";
import { chartUrl } from "@/lib/sources/yahoo";

/**
 * The committed capture in data/snapshot, written by `npm run snapshot`. In live mode it is the
 * last-resort fallback (records labelled "snapshot"); in demo mode it is the whole dataset
 * (labelled "demo") and the clock is frozen at the capture time, so every run shows the same
 * thing. Nothing here touches the network.
 */

export type SeedMode = "snapshot" | "demo";
export type SeedManifest = { capturedAt: string; portfolio: string[]; researchPicks: string[] };

/** market.json: older captures stored bars without adjClose or adjustment info. */
type SeedSeries = Partial<PriceSeries> & { name?: string; currency?: string; bars: (Omit<PriceSeries["bars"][number], "adjClose"> & { adjClose?: number | null })[] };
type MarketSeed = { asOf: string; series: Record<string, SeedSeries> };
type FundamentalsSeed = { capturedAt: string; companies: Record<string, ScreenerCompany> };

export const MANIFEST_FILE = "manifest.json";
export const FUNDAMENTALS_FILE = "fundamentals.json";
export const MARKET_FILE = "market.json";

export type SeedProviders = {
  mode: SeedMode;
  prices: PriceProvider;
  announcements: AnnouncementProvider;
  fundamentals: FundamentalsProvider;
  directory: DirectoryProvider;
  manifest(): Promise<SeedManifest | null>;
  research(symbol: string): Promise<ResearchReport | null>;
};

export function seedProviders(mode: SeedMode, dir: string = config.snapshotDir): SeedProviders {
  const provider = mode === "demo" ? "demo-seed" : "snapshot";
  const label = mode === "demo" ? "Demo dataset" : "Committed snapshot";
  const where = mode === "demo" ? "the demo dataset" : "the committed snapshot";
  const memo = new Map<string, { mtime: number; value: unknown }>();

  async function read<T>(file: string, parse: (raw: string) => T): Promise<T | null> {
    const full = path.join(dir, file);
    try {
      const stat = await fs.stat(full);
      const hit = memo.get(full);
      if (hit && hit.mtime === stat.mtimeMs) return hit.value as T;
      const value = parse(await fs.readFile(full, "utf8"));
      memo.set(full, { mtime: stat.mtimeMs, value });
      return value;
    } catch {
      return null;
    }
  }

  /** Where the data originally came from, labelled with when it was captured and which seed adapter served it. */
  const ref = (adapter: string, url: string, capturedAt: string, type: SourceRef["type"]): SourceRef => ({
    provider: `${provider}-${adapter}`,
    type: mode === "demo" ? "demo" : type,
    url,
    retrievedAt: capturedAt,
    mode,
    note: mode === "demo" ? "Demo mode: captured earlier, not live" : "Live sources failed; served the committed snapshot",
  });

  async function manifest(): Promise<SeedManifest | null> {
    const m = await read(MANIFEST_FILE, (raw) => JSON.parse(raw) as SeedManifest);
    if (m?.capturedAt) return m;
    const archive = await loadArchive(dir);
    return archive ? { capturedAt: archive.updatedAt, portfolio: [], researchPicks: [] } : null;
  }

  const prices: PriceProvider = {
    id: `${provider}-prices`,
    label: `${label}: end-of-day prices`,
    kind: "prices",
    note: mode === "demo" ? "Yahoo Finance bars captured by npm run snapshot; nothing is fetched." : "Used only when every live price source fails.",
    supports: () => true,
    async dailySeries(instrument) {
      const market = await read(MARKET_FILE, (raw) => JSON.parse(raw) as MarketSeed);
      const s = market?.series[instrumentKey(instrument)] ?? (instrument.exchange === "NSE" ? market?.series[instrument.code] : undefined);
      if (!market || !s) throw new NoDataError(`${instrumentSlug(instrument)} is not in ${where}`);
      const bars = s.bars.map((b) => ({ ...b, adjClose: b.adjClose ?? null }));
      return {
        instrument,
        providerSymbol: s.providerSymbol ?? yahooSymbol(instrument),
        name: s.name,
        currency: s.currency ?? "INR",
        adjustment: s.adjustment ?? { close: "split-adjusted", adjClose: bars.some((b) => b.adjClose != null) ? "split-and-dividend" : null },
        sessionOpen: false,
        bars,
        source: ref("prices", s.source?.url ?? chartUrl(yahooSymbol(instrument)), market.asOf, "market-data"),
        issues: [],
      };
    },
  };

  const announcements: AnnouncementProvider = {
    id: `${provider}-filings`,
    label: `${label}: filings archive`,
    kind: "announcements",
    note:
      mode === "demo"
        ? "NSE filings captured by npm run snapshot (feed and API pulls), plus BSE recents listed on screener.in."
        : "FINN's committed archive of earlier NSE pulls; fills the parts of a window live sources do not cover.",
    async recent(q) {
      const archive = await loadArchive(dir);
      if (!archive) throw new SourceError(`No filings archive in ${where} — run npm run snapshot`, provider);
      const wanted = new Set(q.symbols);
      const items = archive.items
        .filter((a) => a.symbol && wanted.has(a.symbol))
        .map((a) => ({ ...a, source: ref("filings", a.via === "screener" ? screenerUrl(a.symbol!, "standalone") : NSE_RSS_URL, archive.updatedAt, "exchange") }));
      const coverage = Object.fromEntries(q.symbols.map((s) => [s, nseCoverage(s, archive, null)]));
      return { items, coverage, source: ref("filings", NSE_RSS_URL, archive.updatedAt, "exchange"), issues: [] };
    },
  };

  const fundamentals: FundamentalsProvider = {
    id: `${provider}-fundamentals`,
    label: `${label}: statements and document links`,
    kind: "fundamentals",
    note: mode === "demo" ? "screener.in pages parsed by npm run snapshot; nothing is fetched." : "Used only when screener.in is unreachable.",
    async company(symbol) {
      const seed = await read(FUNDAMENTALS_FILE, (raw) => JSON.parse(raw) as FundamentalsSeed);
      const c = seed?.companies[symbol];
      if (!seed || !c) throw new NoDataError(`${symbol}'s statements are not in ${where}`);
      return toFundamentals(c, ref("fundamentals", c.url, seed.capturedAt, "aggregator"));
    },
  };

  const directory: DirectoryProvider = {
    id: `${provider}-directory`,
    label: `${label}: NSE equity list`,
    kind: "directory",
    async load() {
      const companies = await read(MASTER_SNAPSHOT_FILE, parseMasterCsv);
      if (!companies) throw new SourceError(`No NSE equity list in ${where}`, provider);
      const capturedAt = (await manifest())?.capturedAt ?? (await fs.stat(path.join(dir, MASTER_SNAPSHOT_FILE))).mtime.toISOString();
      return { companies, index: indexFor(companies), source: ref("directory", NSE_MASTER_URL, capturedAt, "exchange") };
    },
  };

  return { mode, prices, announcements, fundamentals, directory, manifest, research: (symbol) => readSnapshotReport(symbol, dir) };
}
