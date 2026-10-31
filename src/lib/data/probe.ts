import { recentBhavcopies } from "@/lib/data/adapters/prices";
import { nseApiAnnouncements, nseRssAnnouncements } from "@/lib/data/adapters/nse";
import { screenerFundamentals } from "@/lib/data/adapters/screener";
import { track } from "@/lib/data/health";
import { instrumentSlug, type Instrument } from "@/lib/data/instrument";
import { errorMessage, isNoData, type PriceProvider } from "@/lib/data/providers";
import type { PriceSeries, ProviderKind } from "@/lib/data/schema";
import { DataUnavailableError, dataNow, getAnnouncements, getDirectory, getFundamentals, getPrices, providerSet, type ProviderSet, type RunMode } from "@/lib/data/service";
import { fetchPrefix } from "@/lib/net/http";
import { hasTextLayer, loadPdfText } from "@/lib/sources/pdf";

/**
 * A small live sample per provider, to show what actually works from this machine right now.
 * Live mode bypasses caches (maxAgeMs 0) so a cached copy cannot hide a broken source; demo
 * mode inspects the seed. Used by `npm run probe` and /api/status?probe=1.
 */

export type ProbeRow = { kind: ProviderKind; provider: string; sample: string; ok: boolean; ms: number; detail: string };
export type ProbeReport = { mode: RunMode; startedAt: string; rows: ProbeRow[] };

const LIVE = { maxAgeMs: 0 };
const DAY = 86_400_000;

async function sample(kind: ProviderKind, provider: string, label: string, run: () => Promise<string>, opts: { expectNoData?: boolean } = {}): Promise<ProbeRow> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const detail = await run();
    return opts.expectNoData
      ? { kind, provider, sample: label, ok: false, ms: ms(), detail: `Expected no data, got: ${detail}` }
      : { kind, provider, sample: label, ok: true, ms: ms(), detail };
  } catch (err) {
    const noData = isNoData(err) || (err instanceof DataUnavailableError && err.noData);
    if (opts.expectNoData && noData) return { kind, provider, sample: label, ok: true, ms: ms(), detail: `Rejected cleanly: ${errorMessage(err)}` };
    return { kind, provider, sample: label, ok: false, ms: ms(), detail: errorMessage(err) };
  }
}

function describeSeries(s: PriceSeries): string {
  const last = s.bars.at(-1);
  if (!last) return "no sessions";
  const adj = last.adjClose != null ? `, adjusted ₹${last.adjClose.toFixed(2)}` : "";
  return `${s.bars.length} sessions to ${last.date}; close ₹${last.close.toFixed(2)}${adj}; volume ${last.volume?.toLocaleString("en-IN") ?? "n/a"} · ${s.source.mode}`;
}

async function liveProbe(set: ProviderSet): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  const directory = await getDirectory(LIVE, set).catch(() => null);
  rows.push(
    await sample("directory", "nse-master", "NSE equity list", async () => {
      const d = directory ?? (await getDirectory(LIVE, set));
      return `${d.companies.length.toLocaleString("en-IN")} listed symbols · ${d.source.mode}`;
    }),
  );

  const yahoo = set.prices.find((p) => p.id === "yahoo-chart") as PriceProvider;
  const priceSample = (i: Instrument, note: string, expectNoData = false) =>
    sample("prices", yahoo.id, `${instrumentSlug(i)} (${note})`, async () => describeSeries(await track(yahoo, () => yahoo.dailySeries(i, LIVE))), { expectNoData });
  let relianceBars: PriceSeries["bars"] = [];
  rows.push(
    await sample("prices", yahoo.id, "RELIANCE (watchlist)", async () => {
      const s = await track(yahoo, () => yahoo.dailySeries({ exchange: "NSE", code: "RELIANCE" }, LIVE));
      relianceBars = s.bars;
      return describeSeries(s);
    }),
    await priceSample({ exchange: "NSE", code: "IRCTC" }, "outside the watchlist"),
    await priceSample({ exchange: "BSE", code: "TCS" }, "BSE listing"),
    await priceSample({ exchange: "NSE", code: "NOTAREAL123" }, "invalid symbol", true),
  );

  rows.push(
    await sample("prices", "nse-bhavcopy", "latest published session", async () => {
      const [latest] = await recentBhavcopies(1, LIVE);
      if (!latest) throw new Error("No bhavcopy found for the last two weeks");
      const rel = latest.value.rows.RELIANCE;
      // Cross-check the two sources on the same completed session.
      const ref = relianceBars.find((b) => b.date === latest.value.date);
      const check = rel && ref ? ` (Yahoo, same session: ₹${ref.close.toFixed(2)} — ${Math.abs(ref.close - rel[3]) < 0.01 ? "match" : "differs"})` : "";
      return `${latest.value.date}: ${Object.keys(latest.value.rows).length.toLocaleString("en-IN")} equities; RELIANCE as-traded close ₹${rel?.[3].toFixed(2) ?? "n/a"}${check} · ${latest.provenance}`;
    }),
  );

  const now = Date.now();
  if (directory) {
    rows.push(
      await sample("announcements", nseApiAnnouncements.id, "HOMEFIRST, last 7 days", async () => {
        const b = await track(nseApiAnnouncements, () => nseApiAnnouncements.recent({ symbols: ["HOMEFIRST"], from: now - 7 * DAY, to: now, directory }, LIVE));
        const newest = b.items.map((a) => a.ts).sort().at(-1);
        return `${b.items.length} filings${newest ? `, newest ${newest.slice(0, 16).replace("T", " ")}` : ""}${b.issues.length ? ` · ${b.issues.length} rows rejected` : ""} · ${b.source.mode}`;
      }),
      await sample("announcements", nseRssAnnouncements.id, "today's feed (all companies)", async () => {
        const b = await track(nseRssAnnouncements, () => nseRssAnnouncements.recent({ symbols: [...directory.index.bySymbol.keys()], from: now - DAY, to: now, directory }, LIVE));
        const span = b.coverage["*"]?.[0];
        return `${b.items.length} filings${span ? ` since ${new Date(span.from).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""} · ${b.source.mode}`;
      }),
    );
  }

  let docs: Awaited<ReturnType<typeof screenerFundamentals.company>>["documents"] = [];
  rows.push(
    await sample("fundamentals", screenerFundamentals.id, "IRCTC (outside the watchlist)", async () => {
      const f = await track(screenerFundamentals, () => screenerFundamentals.company("IRCTC", LIVE));
      docs = f.documents;
      const count = (k: string) => f.documents.filter((d) => d.kind === k).length;
      return `${f.basis}: ${f.quarters.periods.length} quarters, ${f.annual.periods.length} years; ${count("annual_report")} annual reports, ${count("transcript")} transcripts linked · ${f.source.mode}`;
    }),
  );
  const ar = docs.find((d) => d.kind === "annual_report");
  const transcript = docs.find((d) => d.kind === "transcript");
  rows.push(
    await sample("documents", "annual report", ar ? `${ar.title} (${ar.host})` : "IRCTC annual report", async () => {
      if (!ar) throw new Error("No annual report linked");
      const head = await fetchPrefix(ar.url, { source: "annual report", timeoutMs: 20_000, retries: 0, allowHosts: "public" }, 1024);
      const magic = new TextDecoder().decode(head.prefix.subarray(0, 5));
      if (magic !== "%PDF-") throw new Error(`Not a PDF (${head.contentType || "unknown type"})`);
      return `HTTP ${head.status}, ${head.contentType}; first bytes are a PDF header`;
    }),
    await sample("documents", "transcript", transcript ? `${transcript.title} (${transcript.host})` : "IRCTC transcript", async () => {
      if (!transcript) throw new Error("No transcript linked");
      const text = await loadPdfText(transcript.url, { maxPages: 60, companyHosts: true });
      const chars = text.value.pages.reduce((n, p) => n + p.length, 0);
      return `${text.value.totalPages} pages, ${chars.toLocaleString("en-IN")} characters, text layer ${hasTextLayer(text.value) ? "present" : "missing"} · ${text.provenance}`;
    }),
  );
  return rows;
}

async function demoProbe(set: ProviderSet): Promise<ProbeRow[]> {
  const now = await dataNow(set);
  const rows: ProbeRow[] = [];
  const directory = await getDirectory(undefined, set).catch(() => null);
  rows.push(await sample("directory", set.directory[0].id, "seed equity list", async () => `${directory?.companies.length ?? 0} symbols · demo`));
  rows.push(await sample("prices", set.prices[0].id, "RELIANCE", async () => describeSeries(await getPrices({ exchange: "NSE", code: "RELIANCE" }, undefined, set))));
  rows.push(await sample("prices", set.prices[0].id, "IRCTC (not seeded)", async () => describeSeries(await getPrices({ exchange: "NSE", code: "IRCTC" }, undefined, set)), { expectNoData: true }));
  if (directory) {
    rows.push(
      await sample("announcements", set.announcements[0].id, "HOMEFIRST, 7 days before capture", async () => {
        const [o] = await getAnnouncements({ symbols: ["HOMEFIRST"], from: now - 7 * DAY, to: now, directory }, undefined, set);
        if (!o.ok) throw new Error(o.error);
        return `${o.batch.items.filter((a) => Date.parse(a.ts) >= now - 7 * DAY).length} filings · demo`;
      }),
    );
  }
  rows.push(
    await sample("fundamentals", set.fundamentals[0].id, "HOMEFIRST", async () => {
      const f = await getFundamentals("HOMEFIRST", undefined, set);
      return `${f.quarters.periods.length} quarters; ${f.documents.length} documents linked · demo`;
    }),
  );
  return rows;
}

export async function runProbe(set: ProviderSet = providerSet()): Promise<ProbeReport> {
  const startedAt = new Date().toISOString();
  return { mode: set.mode, startedAt, rows: set.mode === "demo" ? await demoProbe(set) : await liveProbe(set) };
}
