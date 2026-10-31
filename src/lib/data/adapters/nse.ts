import { errorMessage, refFrom, type AnnouncementProvider, type DirectoryProvider, type Interval, type ListedAnnouncement } from "@/lib/data/providers";
import type { DataMode, ExtractionIssue, SourceRef } from "@/lib/data/schema";
import type { Cached } from "@/lib/net/cache";
import { SourceError } from "@/lib/net/http";
import { announcementsApiUrl, fetchAnnouncementsApi, NSE_API_SOURCE, parseAnnouncementsApi } from "@/lib/sources/nse-api";
import { buildIndex, loadMaster, NSE_MASTER_URL, type ListedCompany, type MasterIndex } from "@/lib/sources/nse-master";
import { loadNseFeed, NSE_RSS_URL } from "@/lib/sources/nse-rss";

const indexes = new WeakMap<ListedCompany[], MasterIndex>();

/** Symbol and name lookups, built once per parsed list. */
export function indexFor(list: ListedCompany[]): MasterIndex {
  let index = indexes.get(list);
  if (!index) {
    index = buildIndex(list);
    indexes.set(list, index);
  }
  return index;
}

export const nseDirectory: DirectoryProvider = {
  id: "nse-master",
  label: "NSE equity master list",
  kind: "directory",
  note: "NSE's public EQUITY_L.csv: every listed symbol with its official name and ISIN; refreshed daily.",
  async load(opts) {
    const master = await loadMaster(opts);
    return { companies: master.value, index: indexFor(master.value), source: refFrom("nse-master", "exchange", NSE_MASTER_URL, master) };
  },
};

/** "2026-10-28" for an instant, in IST. */
export function istDay(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

/** A 401/403/429 or an HTML answer from a JSON API means "stop asking", not "try the next symbol". */
function isRefusal(err: unknown): boolean {
  return err instanceof SourceError && ((err.status != null && [401, 403, 429].includes(err.status)) || /instead of JSON/.test(err.message));
}

/** One label for a batch of per-symbol fetches: stale if any was stale, live if any was live. */
function batchMode(metas: Cached<unknown>[]): DataMode {
  if (metas.some((m) => m.provenance === "stale")) return "stale";
  if (metas.some((m) => m.provenance === "live")) return "live";
  return "cache";
}

export const nseApiAnnouncements: AnnouncementProvider = {
  id: "nse-api",
  label: "NSE corporate announcements (nseindia.com)",
  kind: "announcements",
  note: "Undocumented JSON behind nseindia.com's filings page. robots.txt allows it; FINN sends one plain request per symbol and window (cached 10 min) and stops at the first refusal.",
  async recent(q, opts) {
    const from = istDay(q.from);
    const to = istDay(q.to);
    const items: ListedAnnouncement[] = [];
    const coverage: Record<string, Interval[]> = {};
    const issues: ExtractionIssue[] = [];
    const metas: Cached<unknown>[] = [];
    for (let i = 0; i < q.symbols.length; i += 2) {
      const batch = q.symbols.slice(i, i + 2);
      const results = await Promise.allSettled(batch.map((s) => fetchAnnouncementsApi(s, from, to, opts)));
      for (const [j, r] of results.entries()) {
        const symbol = batch[j];
        if (r.status === "rejected") {
          if (isRefusal(r.reason)) throw new SourceError(`${NSE_API_SOURCE} refused the request (${errorMessage(r.reason)}); FINN does not retry a refusal`, NSE_API_SOURCE, 403);
          issues.push({ provider: "nse-api", subject: symbol, message: errorMessage(r.reason) });
          continue;
        }
        let parsed;
        try {
          parsed = parseAnnouncementsApi(r.value.value, symbol);
        } catch (err) {
          issues.push({ provider: "nse-api", subject: symbol, message: errorMessage(err) });
          continue;
        }
        metas.push(r.value);
        const source = refFrom("nse-api", "exchange", announcementsApiUrl(symbol, from, to), r.value);
        for (const a of parsed.items) items.push({ ...a, source });
        for (const message of parsed.rejected) issues.push({ provider: "nse-api", subject: symbol, message });
        coverage[symbol] = [{ from: Date.parse(`${from}T00:00:00+05:30`), to: Math.min(Date.parse(r.value.fetchedAt), q.to) }];
      }
    }
    if (q.symbols.length && !metas.length) {
      throw new SourceError(`${NSE_API_SOURCE}: no symbol could be read (${issues[0]?.message ?? "no response"})`, NSE_API_SOURCE);
    }
    const oldest = metas.map((m) => m.fetchedAt).sort()[0] ?? new Date().toISOString();
    const source: SourceRef = { provider: "nse-api", type: "exchange", url: "https://www.nseindia.com/api/corporate-announcements?index=equities", retrievedAt: oldest, mode: batchMode(metas) };
    return { items, coverage, source, issues };
  },
};

export const nseRssAnnouncements: AnnouncementProvider = {
  id: "nse-rss",
  label: "NSE announcements RSS (official)",
  kind: "announcements",
  note: "Published by NSE for syndication. Holds the current day's filings exchange-wide and restarts at midnight, so older windows need the API or the archive.",
  async recent(q, opts) {
    const feed = await loadNseFeed(q.directory.index, opts);
    const source = refFrom("nse-rss", "exchange", NSE_RSS_URL, feed);
    const wanted = new Set(q.symbols);
    const items = feed.value.items.filter((a) => a.symbol && wanted.has(a.symbol)).map((a) => ({ ...a, source }));
    const coverage: Record<string, Interval[]> = feed.value.coverage ? { "*": [{ from: Date.parse(feed.value.coverage.from), to: Date.parse(feed.fetchedAt) }] } : {};
    return { items, coverage, source, issues: [] };
  },
};
