import { yahooSymbol } from "@/lib/data/instrument";
import { NoDataError, refFrom, type FetchOpts, type PriceProvider } from "@/lib/data/providers";
import type { ExtractionIssue, PriceBar } from "@/lib/data/schema";
import type { Cached } from "@/lib/net/cache";
import { SourceError } from "@/lib/net/http";
import { bhavcopyUrl, loadBhavcopy, weekdaysBack, type Bhavcopy } from "@/lib/sources/nse-bhavcopy";
import { chartUrl, fetchChart, parseChart } from "@/lib/sources/yahoo";

/** Fewer sessions than this cannot support a 20-day volume average. */
export const MIN_SESSIONS = 20;

export const yahooPrices: PriceProvider = {
  id: "yahoo-chart",
  label: "Yahoo Finance chart (end of day)",
  kind: "prices",
  note: "Unofficial endpoint; its robots.txt disallows crawlers, so FINN makes one cached request per symbol (10 min in market hours, 2 h otherwise). Close is split-adjusted; adjusted close also removes dividends. Some BSE (.BO) series are sparse.",
  supports: () => true,
  async dailySeries(instrument, opts) {
    const symbol = yahooSymbol(instrument);
    try {
      const raw = await fetchChart(instrument, opts);
      const parsed = parseChart(symbol, raw.value, Date.parse(raw.fetchedAt));
      const issues: ExtractionIssue[] = parsed.skipped.map((date) => ({ provider: "yahoo-chart", subject: `${symbol} ${date}`, message: "Session listed without a close; skipped" }));
      if (parsed.bars.length < MIN_SESSIONS) {
        issues.push({ provider: "yahoo-chart", subject: symbol, message: `Only ${parsed.bars.length} session(s) returned for the last year` });
      }
      return {
        instrument,
        providerSymbol: symbol,
        name: parsed.name,
        currency: parsed.currency,
        adjustment: { close: "split-adjusted", adjClose: "split-and-dividend" },
        sessionOpen: parsed.sessionOpen,
        bars: parsed.bars,
        source: refFrom("yahoo-chart", "market-data", chartUrl(symbol), raw),
        issues,
      };
    } catch (err) {
      if (err instanceof SourceError && err.status === 404) throw new NoDataError(`Yahoo Finance has no prices for ${symbol}`);
      throw err;
    }
  },
};

/** 20 sessions for the volume average, the session itself, and a 30-session sparkline. */
const BHAV_SESSIONS = 31;

/** The last `sessions` published files, newest first. Weekends are skipped; holidays 404. */
export async function recentBhavcopies(sessions: number, opts: FetchOpts & { now?: number } = {}): Promise<Cached<Bhavcopy>[]> {
  const now = opts.now ?? Date.now();
  const candidates = weekdaysBack(now, sessions + 12);
  const out: Cached<Bhavcopy>[] = [];
  for (let i = 0; i < candidates.length && out.length < sessions; i += 4) {
    const batch = await Promise.all(candidates.slice(i, i + 4).map((date) => loadBhavcopy(date, { now, maxAgeMs: opts.maxAgeMs })));
    for (const file of batch) if (file.value && out.length < sessions) out.push(file as Cached<Bhavcopy>);
  }
  return out;
}

export const bhavcopyPrices: PriceProvider = {
  id: "nse-bhavcopy",
  label: "NSE bhavcopy (official end of day)",
  kind: "prices",
  note: "NSE's own daily files on nsearchives.nseindia.com: as-traded prices with no split or dividend adjustment, NSE listings only. FINN reads the last 31 sessions, so 52-week checks need the Yahoo source.",
  supports: (instrument) => instrument.exchange === "NSE",
  async dailySeries(instrument, opts) {
    // The newest file decides cheaply whether NSE lists the symbol at all, before reading 30 more.
    const [latest] = await recentBhavcopies(1, opts);
    if (!latest) throw new SourceError("No NSE bhavcopy found for the last two weeks", "NSE bhavcopy");
    if (!latest.value.rows[instrument.code]) throw new NoDataError(`${instrument.code} did not trade on NSE in the latest session (${latest.value.date})`);
    const files = await recentBhavcopies(BHAV_SESSIONS, opts);
    const bars: PriceBar[] = [];
    for (const file of [...files].reverse()) {
      const row = file.value.rows[instrument.code];
      if (!row) continue;
      const [open, high, low, close, , volume] = row;
      bars.push({ date: file.value.date, open, high, low, close, adjClose: null, volume });
    }
    if (!bars.length) throw new NoDataError(`${instrument.code} is not in NSE's bhavcopy for the last ${files.length} sessions`);
    const issues: ExtractionIssue[] =
      bars.length < files.length ? [{ provider: "nse-bhavcopy", subject: instrument.code, message: `Traded in ${bars.length} of the last ${files.length} sessions` }] : [];
    return {
      instrument,
      providerSymbol: instrument.code,
      currency: "INR",
      adjustment: { close: "as-traded", adjClose: null },
      // Files are published only after the close, so the last bar is always a completed session.
      sessionOpen: false,
      bars,
      source: refFrom("nse-bhavcopy", "exchange", bhavcopyUrl(latest.value.date), latest),
      issues,
    };
  },
};
