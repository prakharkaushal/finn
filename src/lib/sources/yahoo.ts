import { yahooSymbol, type Instrument } from "@/lib/data/instrument";
import { istDate } from "@/lib/domain/signals";
import { cached, HOUR, MINUTE, type Cached } from "@/lib/net/cache";
import { fetchJson, SourceError } from "@/lib/net/http";

/**
 * Yahoo Finance's public chart endpoint: a year of daily bars per listing (RELIANCE.NS on NSE,
 * TCS.BO on BSE). Close is split-adjusted; adjclose is adjusted for splits and dividends.
 * This module fetches and parses raw responses; the price adapter normalises them.
 */

export type ChartResponse = {
  chart: {
    result?: {
      meta: {
        currency?: string;
        exchangeName?: string;
        longName?: string;
        shortName?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
        currentTradingPeriod?: { regular?: { start: number; end: number } };
      };
      timestamp?: number[];
      indicators: {
        quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[];
        adjclose?: { adjclose: (number | null)[] }[];
      };
    }[];
    error?: { code: string; description: string } | null;
  };
};

export type ChartBar = { date: string; open: number | null; high: number | null; low: number | null; close: number; adjClose: number | null; volume: number | null };

export type ParsedChart = {
  name?: string;
  currency: string;
  exchangeName?: string;
  bars: ChartBar[];
  /** Whether the session was trading when this was fetched (the last bar is then partial). */
  sessionOpen: boolean;
  /** Sessions Yahoo listed without any close; dropped and reported. */
  skipped: string[];
};

export function chartUrl(providerSymbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?range=1y&interval=1d&includeAdjustedClose=true&events=div%2Csplits`;
}

export function parseChart(label: string, data: ChartResponse, now = Date.now()): ParsedChart {
  const result = data.chart.result?.[0];
  if (!result || data.chart.error) {
    throw new SourceError(data.chart.error?.description ?? `No price data for ${label}`, "Yahoo Finance", 404);
  }
  const q = result.indicators.quote[0];
  const adj = result.indicators.adjclose?.[0]?.adjclose ?? [];
  const bars: ChartBar[] = [];
  const skipped: string[] = [];
  const stamps = result.timestamp ?? [];
  const { regularMarketPrice, regularMarketTime } = result.meta;
  stamps.forEach((ts, i) => {
    const date = istDate(ts * 1000);
    let close = q?.close[i] ?? null;
    // Yahoo sometimes leaves the latest bar's close null (with real volume) while the meta
    // carries that session's last traded price; use it only when it is the same session.
    if (close == null && i === stamps.length - 1 && regularMarketPrice != null && regularMarketTime != null && istDate(regularMarketTime * 1000) === date) {
      close = regularMarketPrice;
    }
    if (close == null || !(close > 0)) {
      skipped.push(date);
      return;
    }
    const a = adj[i];
    bars.push({ date, open: q.open[i], high: q.high[i], low: q.low[i], close, adjClose: a != null && a > 0 ? a : null, volume: q.volume[i] });
  });
  const regular = result.meta.currentTradingPeriod?.regular;
  return {
    name: result.meta.longName ?? result.meta.shortName,
    currency: result.meta.currency ?? "INR",
    exchangeName: result.meta.exchangeName,
    bars,
    sessionOpen: Boolean(regular && now / 1000 >= regular.start && now / 1000 < regular.end),
    skipped,
  };
}

/** Prices move during market hours (09:15–15:30 IST, weekdays); otherwise EOD data is stable. */
export function chartTtl(now = Date.now()): number {
  const ist = new Date(now + 330 * 60_000);
  const day = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const marketHours = day >= 1 && day <= 5 && minutes >= 9 * 60 && minutes <= 16 * 60;
  return marketHours ? 10 * MINUTE : 2 * HOUR;
}

/** The raw response is cached and parsed on read, so parser fixes apply to cached data too. */
export async function fetchChart(instrument: Instrument, opts: { maxAgeMs?: number } = {}): Promise<Cached<ChartResponse>> {
  const symbol = yahooSymbol(instrument);
  return cached(symbol, { namespace: "yahoo-chart-v2", ttlMs: opts.maxAgeMs ?? chartTtl() }, () =>
    fetchJson<ChartResponse>(chartUrl(symbol), { source: "Yahoo Finance", timeoutMs: 12_000 }),
  );
}
