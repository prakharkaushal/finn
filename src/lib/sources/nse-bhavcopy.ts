import { inflateRawSync } from "node:zlib";
import { cached, DAY, MINUTE, type Cached } from "@/lib/net/cache";
import { fetchBytes, SourceError } from "@/lib/net/http";
import { splitCsvLine } from "@/lib/sources/nse-master";

/**
 * NSE's official daily bhavcopy for the cash market: one zipped CSV per session with every
 * listed security's as-traded open, high, low, close and volume (no split or dividend
 * adjustment). Published on nsearchives.nseindia.com after the close; never changes after.
 */

export function bhavcopyUrl(date: string): string {
  return `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${date.replaceAll("-", "")}_F_0000.csv.zip`;
}

/** Reads the first file of a zip archive (stored or deflated), located via the central directory. */
export function unzipFirst(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const dir = b.readUInt32LE(eocd + 16);
  if (b.readUInt32LE(dir) !== 0x02014b50) throw new Error("corrupt zip directory");
  const method = b.readUInt16LE(dir + 10);
  const size = b.readUInt32LE(dir + 20);
  const local = b.readUInt32LE(dir + 42);
  if (b.readUInt32LE(local) !== 0x04034b50) throw new Error("corrupt zip entry");
  const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
  const data = b.subarray(start, start + size);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`unsupported zip compression method ${method}`);
}

/** [open, high, low, close, previous close, volume] for one symbol in one session. */
export type BhavRow = [number | null, number | null, number | null, number, number | null, number | null];
export type Bhavcopy = { date: string; rows: Record<string, BhavRow>; series: Record<string, string> };

const SERIES_RANK: Record<string, number> = { EQ: 0, BE: 1, BZ: 2, SM: 3, ST: 4 };

function num(cell: string | undefined): number | null {
  const n = Number((cell ?? "").trim());
  return cell != null && cell.trim() !== "" && Number.isFinite(n) ? n : null;
}

/** Equity rows only (FinInstrmTp STK). Where a symbol trades in several series, EQ wins. */
export function parseBhavcopy(csv: string, date: string): Bhavcopy {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0] ?? "");
  const col = (name: string) => header.indexOf(name);
  const idx = {
    type: col("FinInstrmTp"),
    symbol: col("TckrSymb"),
    series: col("SctySrs"),
    open: col("OpnPric"),
    high: col("HghPric"),
    low: col("LwPric"),
    close: col("ClsPric"),
    prev: col("PrvsClsgPric"),
    volume: col("TtlTradgVol"),
  };
  if (Object.values(idx).some((i) => i < 0)) throw new Error("Unexpected bhavcopy format (columns changed)");
  const rows: Record<string, BhavRow> = {};
  const series: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    if (c[idx.type] !== "STK") continue;
    const symbol = c[idx.symbol]?.toUpperCase();
    const s = c[idx.series] ?? "";
    const close = num(c[idx.close]);
    if (!symbol || close == null || close <= 0 || !(s in SERIES_RANK)) continue;
    if (symbol in series && SERIES_RANK[series[symbol]] <= SERIES_RANK[s]) continue;
    series[symbol] = s;
    rows[symbol] = [num(c[idx.open]), num(c[idx.high]), num(c[idx.low]), close, num(c[idx.prev]), num(c[idx.volume])];
  }
  return { date, rows, series };
}

/**
 * One session's file. Published files never change, so once a date is two days old its
 * answer (the file, or a 404 for a holiday) is kept for good; recent dates are rechecked
 * every 30 minutes because the file appears only after the close.
 */
export async function loadBhavcopy(date: string, opts: { now?: number; maxAgeMs?: number } = {}): Promise<Cached<Bhavcopy | null>> {
  const ageDays = ((opts.now ?? Date.now()) - Date.parse(`${date}T18:30:00+05:30`)) / DAY;
  const settled = ageDays > 2;
  return cached(
    date,
    { namespace: settled ? "nse-bhavcopy-v1" : "nse-bhavcopy-recent-v1", ttlMs: opts.maxAgeMs ?? (settled ? Infinity : 30 * MINUTE) },
    async () => {
      try {
        const bytes = await fetchBytes(bhavcopyUrl(date), { source: "NSE bhavcopy", timeoutMs: 20_000, retries: 1, maxBytes: 8 * 1024 * 1024 });
        return parseBhavcopy(unzipFirst(bytes), date);
      } catch (err) {
        if (err instanceof SourceError && err.status === 404) return null;
        throw err;
      }
    },
  );
}

/** Weekdays (IST) going back from `from`, newest first; holidays are skipped by the 404 above. */
export function weekdaysBack(from: number, count: number): string[] {
  const out: string[] = [];
  for (let d = 0; out.length < count && d < count * 2 + 10; d++) {
    const day = new Date(from + 330 * 60_000 - d * DAY);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(day.toISOString().slice(0, 10));
  }
  return out;
}
