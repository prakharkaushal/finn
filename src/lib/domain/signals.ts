import { mean, pctChange } from "@/lib/domain/numbers";

/** End-of-day price/volume rules. The investor sets the thresholds; FINN watches. */

export type Bar = { date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null };

export type Thresholds = { pricePct: number; volumeMultiple: number; lookback: number };

export const DEFAULT_THRESHOLDS: Thresholds = { pricePct: 4, volumeMultiple: 2, lookback: 20 };

export type RuleHit = { id: "price" | "volume" | "high52" | "low52"; label: string };

export type MarketSignal = {
  date: string;
  close: number;
  prevClose: number | null;
  changePct: number | null;
  volume: number | null;
  avgVolume: number | null;
  volumeRatio: number | null;
  spark: number[];
  hits: RuleHit[];
  /** True when today's bar was dropped because the session is still trading. */
  excludedPartialSession: boolean;
};

/** IST calendar date for an instant. */
export function istDate(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

export function computeSignal(
  rawBars: Bar[],
  t: Thresholds,
  opts: { sessionOpen: boolean; now?: number },
): MarketSignal | null {
  const sorted = rawBars.filter((b) => Number.isFinite(b.close)).sort((a, b) => a.date.localeCompare(b.date));
  // One bar per session: a provider can send the latest session twice (at the open and live).
  // Kept twice, the day would be compared with itself. The sort is stable, so the last copy wins.
  let bars = sorted.filter((b, i) => sorted[i + 1]?.date !== b.date);
  let excludedPartialSession = false;
  const today = istDate(opts.now ?? Date.now());
  if (opts.sessionOpen && bars.at(-1)?.date === today) {
    bars = bars.slice(0, -1);
    excludedPartialSession = true;
  }
  if (bars.length < 2) return null;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const changePct = pctChange(last.close, prev.close);

  const window = bars
    .slice(Math.max(0, bars.length - 1 - t.lookback), bars.length - 1)
    .map((b) => b.volume)
    .filter((v): v is number => v != null && v > 0);
  const avgVolume = window.length >= Math.min(5, t.lookback) ? mean(window) : null;
  const volumeRatio = avgVolume && last.volume != null ? last.volume / avgVolume : null;

  const hits: RuleHit[] = [];
  if (changePct != null && Math.abs(changePct) >= t.pricePct) {
    hits.push({ id: "price", label: `Moved ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% (rule: ±${t.pricePct}%)` });
  }
  if (volumeRatio != null && volumeRatio >= t.volumeMultiple) {
    hits.push({ id: "volume", label: `Volume ${volumeRatio.toFixed(1)}× ${t.lookback}-day average (rule: ${t.volumeMultiple}×)` });
  }
  const history = bars.slice(Math.max(0, bars.length - 251), bars.length - 1).map((b) => b.close);
  if (history.length >= 200) {
    if (last.close > Math.max(...history)) hits.push({ id: "high52", label: "Closed at a 52-week high" });
    if (last.close < Math.min(...history)) hits.push({ id: "low52", label: "Closed at a 52-week low" });
  }

  return {
    date: last.date,
    close: last.close,
    prevClose: prev.close,
    changePct,
    volume: last.volume,
    avgVolume,
    volumeRatio,
    spark: bars.slice(-30).map((b) => b.close),
    hits,
    excludedPartialSession,
  };
}
