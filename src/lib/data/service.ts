import { bhavcopyPrices, yahooPrices } from "@/lib/data/adapters/prices";
import { nseApiAnnouncements, nseDirectory, nseRssAnnouncements } from "@/lib/data/adapters/nse";
import { screenerFundamentals } from "@/lib/data/adapters/screener";
import { seedProviders, type SeedProviders } from "@/lib/data/adapters/seed";
import { track, type Assessment } from "@/lib/data/health";
import { instrumentSlug, type Instrument } from "@/lib/data/instrument";
import {
  errorMessage,
  isNoData,
  type AnnouncementBatch,
  type AnnouncementProvider,
  type AnnouncementQuery,
  type Directory,
  type DirectoryProvider,
  type FetchOpts,
  type FundamentalsProvider,
  type PriceProvider,
  type ProviderMeta,
} from "@/lib/data/providers";
import type { CompanyFundamentals, PriceSeries, SourceRef } from "@/lib/data/schema";

/**
 * The one door business logic uses for data. FINN_DATA_MODE=demo swaps every provider for the
 * committed demo dataset (clearly labelled); otherwise each kind of data has an ordered chain
 * of live providers ending in the committed snapshot. FINN_PRICE_PROVIDER=nse-bhavcopy puts
 * NSE's official files ahead of Yahoo.
 */

export type RunMode = "live" | "demo";

export function runMode(): RunMode {
  return (process.env.FINN_DATA_MODE ?? "").trim().toLowerCase() === "demo" ? "demo" : "live";
}

/** A visitor's choice of data, kept in a cookie so every API call of the visit agrees. */
export { DATA_COOKIE } from "@/lib/data/mode";

/**
 * The mode one request runs in. FINN_DATA_MODE=demo forces demo for everyone (an offline
 * deployment); otherwise a visitor may opt into the committed demo dataset — the path that
 * still works when a live source is rate-limited or down. FINN_DATA_MODE=demo-first starts a
 * visitor who has not chosen on demo data (for a host the exchange does not answer); the
 * visitor can still switch to live.
 */
export function modeFor(cookie: string | undefined): RunMode {
  if (runMode() === "demo") return "demo";
  if (cookie === "demo" || cookie === "live") return cookie;
  return (process.env.FINN_DATA_MODE ?? "").trim().toLowerCase() === "demo-first" ? "demo" : "live";
}

export type ProviderSet = {
  mode: RunMode;
  prices: PriceProvider[];
  announcements: AnnouncementProvider[];
  fundamentals: FundamentalsProvider[];
  directory: DirectoryProvider[];
  seed: SeedProviders;
};

const sets = new Map<string, ProviderSet>();

export function providerSet(mode: RunMode = runMode()): ProviderSet {
  const bhavcopyFirst = (process.env.FINN_PRICE_PROVIDER ?? "").trim().toLowerCase() === "nse-bhavcopy";
  const key = `${mode}:${bhavcopyFirst}`;
  let set = sets.get(key);
  if (set) return set;
  if (mode === "demo") {
    const seed = seedProviders("demo");
    set = { mode, prices: [seed.prices], announcements: [seed.announcements], fundamentals: [seed.fundamentals], directory: [seed.directory], seed };
  } else {
    const seed = seedProviders("snapshot");
    set = {
      mode,
      prices: [...(bhavcopyFirst ? [bhavcopyPrices, yahooPrices] : [yahooPrices, bhavcopyPrices]), seed.prices],
      // All announcement providers are read and merged: each covers a different stretch of time.
      announcements: [nseApiAnnouncements, nseRssAnnouncements, seed.announcements],
      fundamentals: [screenerFundamentals, seed.fundamentals],
      directory: [nseDirectory, seed.directory],
      seed,
    };
  }
  sets.set(key, set);
  return set;
}

export function allProviders(set: ProviderSet = providerSet()): ProviderMeta[] {
  const seen = new Set<string>();
  return [...set.prices, ...set.announcements, ...set.fundamentals, ...set.directory].filter((p) => !seen.has(p.id) && seen.add(p.id));
}

/** Demo mode replays the capture, so "now" is when the seed was captured. */
export async function dataNow(set: ProviderSet = providerSet()): Promise<number> {
  if (set.mode === "demo") {
    const manifest = await set.seed.manifest();
    if (manifest) return Date.parse(manifest.capturedAt);
  }
  return Date.now();
}

export type Attempt = { provider: string; error: string; noData: boolean };

/** Every provider in the chain failed or had nothing; `attempts` says which and why. */
export class DataUnavailableError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[],
  ) {
    super(message);
    this.name = "DataUnavailableError";
  }
  /** True when every provider answered "nothing for this input" rather than failing. */
  get noData(): boolean {
    return this.attempts.length > 0 && this.attempts.every((a) => a.noData);
  }
}

async function firstAvailable<P extends ProviderMeta, T>(providers: P[], what: string, call: (p: P) => Promise<T>, assess?: (value: T) => Assessment): Promise<T> {
  const attempts: Attempt[] = [];
  for (const p of providers) {
    try {
      return await track(p, () => call(p), assess);
    } catch (err) {
      attempts.push({ provider: p.label, error: errorMessage(err), noData: isNoData(err) });
    }
  }
  const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join(" · ");
  throw new DataUnavailableError(`${what}${detail ? ` (${detail})` : ""}`, attempts);
}

const staleNote = (source: SourceRef) => (source.mode === "stale" ? (source.note ?? "Served a stale copy") : undefined);

export function getPrices(instrument: Instrument, opts?: FetchOpts, set: ProviderSet = providerSet()): Promise<PriceSeries> {
  const chain = set.prices.filter((p) => p.supports(instrument));
  return firstAvailable(chain, `No end-of-day prices for ${instrumentSlug(instrument)}`, (p) => p.dailySeries(instrument, opts), (s) => ({
    degraded: staleNote(s.source) ?? (s.bars.length < 20 ? `Only ${s.bars.length} sessions for ${s.providerSymbol}` : undefined),
    issues: s.issues,
  }));
}

export function getFundamentals(symbol: string, opts?: FetchOpts, set: ProviderSet = providerSet()): Promise<CompanyFundamentals> {
  return firstAvailable(set.fundamentals, `No statements for ${symbol}`, (p) => p.company(symbol, opts), (f) => ({ degraded: staleNote(f.source), issues: f.issues }));
}

export function getDirectory(opts?: FetchOpts, set: ProviderSet = providerSet()): Promise<Directory> {
  return firstAvailable(set.directory, "NSE equity list unavailable", (p) => p.load(opts), (d) => ({ degraded: staleNote(d.source) }));
}

export type AnnouncementOutcome = { provider: AnnouncementProvider } & ({ ok: true; batch: AnnouncementBatch } | { ok: false; error: string });

/** Every announcement provider is asked; the inbox merges what they return. */
export function getAnnouncements(query: AnnouncementQuery, opts?: FetchOpts, set: ProviderSet = providerSet()): Promise<AnnouncementOutcome[]> {
  return Promise.all(
    set.announcements.map(async (provider): Promise<AnnouncementOutcome> => {
      try {
        const batch = await track(provider, () => provider.recent(query, opts), (b) => ({ degraded: staleNote(b.source), issues: b.issues }));
        return { provider, ok: true, batch };
      } catch (err) {
        return { provider, ok: false, error: errorMessage(err) };
      }
    }),
  );
}
