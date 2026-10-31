import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import type { RawAnnouncement } from "@/lib/data/schema";
import type { XbrlDocument } from "@/lib/sources/xbrl";

/**
 * The NSE feed only holds about a day of filings, so `npm run snapshot` keeps an
 * append-only archive of feed pulls for tracked symbols. Each pull records the window it
 * fully covers, which tells the inbox exactly where its NSE coverage has gaps.
 */

export type ArchivedAnnouncement = RawAnnouncement & { xbrl?: XbrlDocument };
export type ArchivePull = { fetchedAt: string; from: string; symbols: string[] };
export type Archive = { version: 1; updatedAt: string; pulls: ArchivePull[]; items: ArchivedAnnouncement[] };

export const ARCHIVE_FILE = "filings-archive.json";

const memo = new Map<string, { mtime: number; archive: Archive }>();

export async function loadArchive(dir: string = config.snapshotDir): Promise<Archive | null> {
  const file = path.join(dir, ARCHIVE_FILE);
  try {
    const stat = await fs.stat(file);
    const hit = memo.get(file);
    if (hit && hit.mtime === stat.mtimeMs) return hit.archive;
    const archive = JSON.parse(await fs.readFile(file, "utf8")) as Archive;
    memo.set(file, { mtime: stat.mtimeMs, archive });
    return archive;
  } catch {
    return null;
  }
}

export type Interval = { from: number; to: number };

/** Windows in which NSE filings for `symbol` are known to be complete. */
export function nseCoverage(symbol: string, archive: Archive | null, live: Interval | null): Interval[] {
  const out: Interval[] = [];
  for (const p of archive?.pulls ?? []) {
    if (p.symbols.includes(symbol)) out.push({ from: Date.parse(p.from), to: Date.parse(p.fetchedAt) });
  }
  if (live) out.push(live);
  return mergeIntervals(out);
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.to >= i.from).sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.from <= last.to) last.to = Math.max(last.to, i.to);
    else out.push({ ...i });
  }
  return out;
}

export function covered(ts: number, intervals: Interval[]): boolean {
  return intervals.some((i) => ts >= i.from && ts <= i.to);
}

/** Parts of [from, to] not covered by the intervals — reported to the user as gaps. */
export function gapsWithin(from: number, to: number, intervals: Interval[]): Interval[] {
  const gaps: Interval[] = [];
  let cursor = from;
  for (const i of mergeIntervals(intervals)) {
    if (i.to < cursor) continue;
    if (i.from > to) break;
    if (i.from > cursor) gaps.push({ from: cursor, to: Math.min(i.from, to) });
    cursor = Math.max(cursor, i.to);
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

/** Appends a feed pull for tracked symbols; used by the snapshot script. */
export function appendPull(
  archive: Archive | null,
  pull: { fetchedAt: string; from: string; items: ArchivedAnnouncement[] },
  symbols: string[],
): Archive {
  const base: Archive = archive ?? { version: 1, updatedAt: pull.fetchedAt, pulls: [], items: [] };
  const tracked = new Set(symbols);
  const byId = new Map(base.items.map((i) => [i.id, i]));
  for (const item of pull.items) {
    if (!item.symbol || !tracked.has(item.symbol)) continue;
    const prev = byId.get(item.id);
    byId.set(item.id, { ...item, via: item.via === "nse-rss" || item.via === "nse-api" ? "archive" : item.via, xbrl: item.xbrl ?? prev?.xbrl });
  }
  const items = [...byId.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  // A cached feed served twice is one pull, not two.
  const known = base.pulls.some((p) => p.fetchedAt === pull.fetchedAt);
  const pulls = known ? base.pulls : [...base.pulls, { fetchedAt: pull.fetchedAt, from: pull.from, symbols: [...tracked].sort() }];
  const updatedAt = [base.updatedAt, pull.fetchedAt].sort().at(-1)!;
  return { version: 1, updatedAt: archive ? updatedAt : pull.fetchedAt, pulls, items };
}
