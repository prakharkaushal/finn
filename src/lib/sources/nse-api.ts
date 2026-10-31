import type { RawAnnouncement } from "@/lib/data/schema";
import { cached, MINUTE, type Cached } from "@/lib/net/cache";
import { fetchJson, SourceError } from "@/lib/net/http";
import { docTypeOf, parseNseTimestamp } from "@/lib/sources/nse-rss";

/**
 * The corporate-announcements JSON behind nseindia.com's filings page: every NSE filing for
 * one symbol over a date range, with its attachment link. It is undocumented. robots.txt
 * allows it and it answers plain requests, so FINN calls it politely (one request per symbol
 * and window, cached 10 minutes) and treats any refusal as "down" — no cookies or header tricks.
 */

export const NSE_API_SOURCE = "NSE announcements API";

/** "2026-10-21" → "21-10-2026", the form the endpoint expects. */
function dmy(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}-${m}-${y}`;
}

export function announcementsApiUrl(symbol: string, from: string, to: string): string {
  const sp = new URLSearchParams({ index: "equities", symbol, from_date: dmy(from), to_date: dmy(to) });
  return `https://www.nseindia.com/api/corporate-announcements?${sp.toString()}`;
}

type ApiRow = { an_dt?: unknown; symbol?: unknown; sm_name?: unknown; desc?: unknown; attchmntText?: unknown; attchmntFile?: unknown };

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** Rows without a filing time or a document link are rejected (and reported), not guessed. */
export function parseAnnouncementsApi(payload: unknown, symbol: string): { items: RawAnnouncement[]; rejected: string[] } {
  if (!Array.isArray(payload)) {
    throw new SourceError(`${NSE_API_SOURCE} returned an unexpected payload (not a list)`, NSE_API_SOURCE);
  }
  const items: RawAnnouncement[] = [];
  const rejected: string[] = [];
  for (const row of payload as ApiRow[]) {
    const ts = parseNseTimestamp(text(row?.an_dt));
    const url = text(row?.attchmntFile);
    const subject = text(row?.desc);
    if (!ts || !/^https:\/\/\S+$/.test(url)) {
      rejected.push(`${subject || "filing"} at ${text(row?.an_dt) || "unknown time"}: no ${ts ? "document link" : "parsable time"}`);
      continue;
    }
    items.push({
      id: url,
      symbol: (text(row.symbol) || symbol).toUpperCase(),
      companyName: text(row.sm_name) || symbol,
      subject,
      description: text(row.attchmntText),
      url,
      docType: docTypeOf(url),
      ts,
      exchange: "NSE",
      via: "nse-api",
    });
  }
  return { items, rejected };
}

/** Raw payload, cached per symbol and date range; parsed on read. */
export async function fetchAnnouncementsApi(symbol: string, from: string, to: string, opts: { maxAgeMs?: number } = {}): Promise<Cached<unknown>> {
  return cached(`${symbol}:${from}:${to}`, { namespace: "nse-api-announcements-v1", ttlMs: opts.maxAgeMs ?? 10 * MINUTE }, () =>
    fetchJson<unknown>(announcementsApiUrl(symbol, from, to), { source: NSE_API_SOURCE, timeoutMs: 15_000, retries: 1 }),
  );
}
