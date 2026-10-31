import type { Instrument } from "@/lib/data/instrument";
import type { Announcement, CompanyFundamentals, ExtractionIssue, PriceSeries, ProviderKind, SourceRef } from "@/lib/data/schema";
import type { Cached } from "@/lib/net/cache";
import type { ListedCompany, MasterIndex } from "@/lib/sources/nse-master";
import type { XbrlDocument } from "@/lib/sources/xbrl";

/**
 * Provider contracts. The inbox and research code depend on these, never on a particular
 * source, so any adapter can be replaced by another that returns the same canonical records.
 */

/** maxAgeMs: 0 forces a live fetch (used by the probe); omitted = the adapter's normal TTL. */
export type FetchOpts = { maxAgeMs?: number };

export type ProviderMeta = {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Standing caveat shown in the status view: terms, robots.txt, coverage limits. */
  note?: string;
};

export interface PriceProvider extends ProviderMeta {
  kind: "prices";
  supports(instrument: Instrument): boolean;
  dailySeries(instrument: Instrument, opts?: FetchOpts): Promise<PriceSeries>;
}

export type Directory = { companies: ListedCompany[]; index: MasterIndex; source: SourceRef };

export interface DirectoryProvider extends ProviderMeta {
  kind: "directory";
  load(opts?: FetchOpts): Promise<Directory>;
}

export type Interval = { from: number; to: number };

/** Announcements may carry structured XBRL already parsed by the archive. */
export type ListedAnnouncement = Announcement & { xbrl?: XbrlDocument };

export type AnnouncementQuery = { symbols: string[]; from: number; to: number; directory: Directory };

export type AnnouncementBatch = {
  items: ListedAnnouncement[];
  /** Per symbol ("*" = every symbol): intervals over which this listing is known to be complete. */
  coverage: Record<string, Interval[]>;
  source: SourceRef;
  issues: ExtractionIssue[];
};

export interface AnnouncementProvider extends ProviderMeta {
  kind: "announcements";
  recent(query: AnnouncementQuery, opts?: FetchOpts): Promise<AnnouncementBatch>;
}

export interface FundamentalsProvider extends ProviderMeta {
  kind: "fundamentals";
  company(symbol: string, opts?: FetchOpts): Promise<CompanyFundamentals>;
}

/**
 * The provider answered but holds nothing for this input (unknown symbol, not in the demo
 * dataset). Distinct from a failure: it does not mark the provider as down.
 */
export class NoDataError extends Error {
  readonly noData = true;
}

export function isNoData(err: unknown): boolean {
  return err instanceof NoDataError || (typeof err === "object" && err !== null && (err as { status?: number }).status === 404);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A SourceRef from a cache result: live, cache or stale, with the reason when stale. */
export function refFrom(provider: string, type: SourceRef["type"], url: string, meta: Pick<Cached<unknown>, "fetchedAt" | "provenance" | "error">): SourceRef {
  return {
    provider,
    type,
    url,
    retrievedAt: meta.fetchedAt,
    mode: meta.provenance,
    ...(meta.error ? { note: `Live fetch failed (${meta.error}); served the last good copy` } : {}),
  };
}
