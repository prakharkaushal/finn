import { XMLParser } from "fast-xml-parser";
import type { RawAnnouncement } from "@/lib/data/schema";
import { cached, MINUTE, type Cached } from "@/lib/net/cache";
import { fetchText } from "@/lib/net/http";
import { nameKey, type MasterIndex } from "@/lib/sources/nse-master";

/**
 * NSE's official "Online announcements" RSS feed. It is published for syndication, refreshes
 * every few minutes and holds the current day's filings exchange-wide (it restarts at midnight).
 */
export const NSE_RSS_URL = "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml";

export type DocType = RawAnnouncement["docType"];

export type FeedPull = {
  items: RawAnnouncement[];
  /** Oldest and newest item times: the window this pull fully covers. */
  coverage: { from: string; to: string } | null;
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "27-Oct-2026 22:21:09" (IST) → "2026-10-27T22:21:09+05:30". */
export function parseNseTimestamp(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6] ?? "00"}+05:30`;
}

export function docTypeOf(url: string): DocType {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".pdf")) return "pdf";
  if (path.endsWith(".xml")) return "xbrl";
  if (path.endsWith(".zip")) return "zip";
  return "other";
}

/** Splits "… has informed the Exchange about X |SUBJECT: Y" into description and subject. */
export function splitDescription(raw: string): { description: string; subject: string } {
  const text = raw.replace(/\s+/g, " ").trim();
  const idx = text.lastIndexOf("|SUBJECT:");
  if (idx < 0) return { description: text, subject: "" };
  return { description: text.slice(0, idx).trim(), subject: text.slice(idx + "|SUBJECT:".length).trim() };
}

/** Name match first (the feed title is the official company name), then the filename prefix. */
export function resolveSymbol(companyName: string, url: string, index: MasterIndex): string | null {
  const byName = index.byName.get(nameKey(companyName));
  if (byName) return byName;
  const file = url.split("/").pop() ?? "";
  const prefix = file.split("_")[0]?.toUpperCase();
  if (prefix && index.bySymbol.has(prefix)) return prefix;
  return null;
}

type RawItem = { title?: unknown; link?: unknown; description?: unknown; pubDate?: unknown };

const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true, trimValues: true });

export function parseNseRss(xml: string, index: MasterIndex): FeedPull {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RawItem | RawItem[] } } };
  const rawItems = doc.rss?.channel?.item;
  const list = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  const items: RawAnnouncement[] = [];
  for (const it of list) {
    const url = String(it.link ?? "").trim();
    const ts = parseNseTimestamp(String(it.pubDate ?? ""));
    if (!url || !ts) continue;
    const companyName = String(it.title ?? "").trim();
    const { description, subject } = splitDescription(String(it.description ?? ""));
    items.push({
      id: url,
      symbol: resolveSymbol(companyName, url, index),
      companyName,
      subject,
      description,
      url,
      docType: docTypeOf(url),
      ts,
      exchange: "NSE",
      via: "nse-rss",
    });
  }
  const times = items.map((i) => Date.parse(i.ts)).filter(Number.isFinite);
  const coverage = times.length
    ? { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() }
    : null;
  return { items, coverage };
}

/** The raw XML is cached and parsed on read against the current master list. */
export async function loadNseFeed(index: MasterIndex, opts: { maxAgeMs?: number } = {}): Promise<Cached<FeedPull>> {
  const raw = await cached(NSE_RSS_URL, { namespace: "nse-rss-xml-v1", ttlMs: opts.maxAgeMs ?? 5 * MINUTE }, () =>
    fetchText(NSE_RSS_URL, { source: "NSE announcements feed", timeoutMs: 12_000 }),
  );
  return { ...raw, value: parseNseRss(raw.value, index) };
}
