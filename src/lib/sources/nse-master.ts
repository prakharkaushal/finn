import { cached, DAY, type Cached } from "@/lib/net/cache";
import { fetchText } from "@/lib/net/http";

/** NSE's public equity master list: every listed symbol with its official name and ISIN. */
export const NSE_MASTER_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
/** The committed copy in data/snapshot, used by the seed adapter. */
export const MASTER_SNAPSHOT_FILE = "nse-equity-list.csv";

import { nameKey } from "@/lib/domain/ticker";

export { nameKey, normalizeTicker, type TickerInput } from "@/lib/domain/ticker";

export type ListedCompany = { symbol: string; name: string; isin: string; series: string };

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseMasterCsv(csv: string): ListedCompany[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const iSym = col("SYMBOL");
  const iName = col("NAME OF COMPANY");
  const iSeries = col("SERIES");
  const iIsin = col("ISIN NUMBER");
  if (iSym < 0 || iName < 0) throw new Error("Unexpected NSE master list format");
  return lines.slice(1).flatMap((line) => {
    const cells = splitCsvLine(line);
    const symbol = cells[iSym]?.toUpperCase();
    if (!symbol) return [];
    return [{ symbol, name: cells[iName] ?? symbol, series: cells[iSeries] ?? "", isin: cells[iIsin] ?? "" }];
  });
}

let parsedMemo: { at: string; list: ListedCompany[] } | null = null;

/** The raw CSV is cached for a day and parsed on read (once per fetch). */
export async function loadMaster(opts: { maxAgeMs?: number } = {}): Promise<Cached<ListedCompany[]>> {
  const raw = await cached(NSE_MASTER_URL, { namespace: "nse-master-csv-v1", ttlMs: opts.maxAgeMs ?? DAY }, () =>
    fetchText(NSE_MASTER_URL, { source: "NSE equity list", timeoutMs: 10_000 }),
  );
  if (!parsedMemo || parsedMemo.at !== raw.fetchedAt) parsedMemo = { at: raw.fetchedAt, list: parseMasterCsv(raw.value) };
  return { ...raw, value: parsedMemo.list };
}

export type MasterIndex = {
  bySymbol: Map<string, ListedCompany>;
  byName: Map<string, string>;
};

export function buildIndex(list: ListedCompany[]): MasterIndex {
  const bySymbol = new Map<string, ListedCompany>();
  const byName = new Map<string, string>();
  for (const c of list) {
    bySymbol.set(c.symbol, c);
    byName.set(nameKey(c.name), c.symbol);
  }
  return { bySymbol, byName };
}

/** Ranked symbol/name search for the research box. Deterministic and cheap. */
export function searchCompanies(list: ListedCompany[], query: string, limit = 8): ListedCompany[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const qName = q.toLowerCase();
  const scored: { c: ListedCompany; score: number }[] = [];
  for (const c of list) {
    const name = c.name.toLowerCase();
    let score = 0;
    if (c.symbol === q) score = 100;
    else if (c.symbol.startsWith(q)) score = 80 - Math.min(c.symbol.length - q.length, 20);
    else if (name.startsWith(qName)) score = 60;
    else if (name.split(/\s+/).some((w) => w.startsWith(qName))) score = 50;
    else if (c.symbol.includes(q)) score = 30;
    else if (name.includes(qName)) score = 20;
    if (score > 0) {
      if (c.series === "EQ") score += 1;
      scored.push({ c, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.c.symbol.localeCompare(b.c.symbol))
    .slice(0, limit)
    .map((s) => s.c);
}
