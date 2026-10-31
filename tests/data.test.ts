import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { documentsFrom, periodValues, toFundamentals, unitOf } from "@/lib/data/adapters/screener";
import { seedProviders } from "@/lib/data/adapters/seed";
import { healthOf, resetHealth } from "@/lib/data/health";
import { instrumentKey, instrumentSlug, parseInstrument, yahooSymbol } from "@/lib/data/instrument";
import { NoDataError, type PriceProvider } from "@/lib/data/providers";
import { alertCategoriesFromRules, rulesFromSettings, thresholdsFromRules } from "@/lib/data/rules";
import {
  AlertRuleSchema,
  AnnouncementSchema,
  CompanySchema,
  PeriodValueSchema,
  PriceSeriesSchema,
  PrimarySourceSchema,
  ResearchClaimSchema,
  type PriceSeries,
  type SourceRef,
} from "@/lib/data/schema";
import { DataUnavailableError, getPrices, runMode, type ProviderSet } from "@/lib/data/service";
import { DEFAULT_ALERT_CATEGORIES } from "@/lib/domain/categories";
import { DEFAULT_THRESHOLDS } from "@/lib/domain/signals";
import { analyzeFinancials } from "@/lib/research/financials";
import { announcementsApiUrl, parseAnnouncementsApi } from "@/lib/sources/nse-api";
import { parseBhavcopy, unzipFirst, weekdaysBack } from "@/lib/sources/nse-bhavcopy";
import { parseScreenerPage } from "@/lib/sources/screener";
import { parseChart } from "@/lib/sources/yahoo";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const LIVE_REF: SourceRef = { provider: "test", type: "aggregator", url: "https://www.screener.in/company/RELIANCE/consolidated/", retrievedAt: "2026-10-28T03:46:00.000Z", mode: "live" };

describe("instrument parsing", () => {
  it("accepts NSE and BSE forms", () => {
    expect(parseInstrument("reliance")).toEqual({ ok: true, instrument: { exchange: "NSE", code: "RELIANCE" } });
    expect(parseInstrument(" RELIANCE.NS ")).toEqual({ ok: true, instrument: { exchange: "NSE", code: "RELIANCE" } });
    expect(parseInstrument("nse:m&m")).toEqual({ ok: true, instrument: { exchange: "NSE", code: "M&M" } });
    expect(parseInstrument("tcs.bo")).toEqual({ ok: true, instrument: { exchange: "BSE", code: "TCS" } });
    expect(parseInstrument("BSE:BAJAJ-AUTO")).toEqual({ ok: true, instrument: { exchange: "BSE", code: "BAJAJ-AUTO" } });
  });

  it("maps to provider symbols and keys", () => {
    expect(yahooSymbol({ exchange: "NSE", code: "IRCTC" })).toBe("IRCTC.NS");
    expect(yahooSymbol({ exchange: "BSE", code: "TCS" })).toBe("TCS.BO");
    expect(instrumentKey({ exchange: "BSE", code: "TCS" })).toBe("BSE:TCS");
    expect(instrumentSlug({ exchange: "BSE", code: "TCS" })).toBe("TCS.BO");
    expect(instrumentSlug({ exchange: "NSE", code: "TCS" })).toBe("TCS");
  });

  it("rejects bad input with a reason instead of guessing", () => {
    expect(parseInstrument("")).toMatchObject({ ok: false });
    expect(parseInstrument("500325")).toMatchObject({ ok: false, error: expect.stringMatching(/scrip code/) });
    expect(parseInstrument("NSE:TCS.BO")).toMatchObject({ ok: false, error: expect.stringMatching(/two different exchanges/) });
    expect(parseInstrument("DROP TABLE;")).toMatchObject({ ok: false });
  });
});

describe("Yahoo chart normalisation", () => {
  const ts = (d: number) => Date.UTC(2026, 9, d, 3, 45) / 1000;
  const chart = {
    chart: {
      result: [
        {
          meta: { currency: "INR", exchangeName: "BSE", longName: "Tata Consultancy Services Limited" },
          timestamp: [ts(23), ts(26), ts(27)],
          indicators: {
            quote: [{ open: [2480, 2490, null], high: [2510, 2512, null], low: [2470, 2480, null], close: [2500, 2505, null], volume: [10_000, 12_000, null] }],
            adjclose: [{ adjclose: [2488.1, 2505, null] }],
          },
        },
      ],
      error: null,
    },
  };

  it("keeps adjusted closes and reports sessions without a close", () => {
    const parsed = parseChart("TCS.BO", chart, Date.UTC(2026, 9, 28));
    expect(parsed.exchangeName).toBe("BSE");
    expect(parsed.bars).toHaveLength(2);
    expect(parsed.bars[0]).toMatchObject({ date: "2026-10-23", close: 2500, adjClose: 2488.1 });
    expect(parsed.skipped).toEqual(["2026-10-27"]);
  });

  it("produces a valid canonical series", () => {
    const parsed = parseChart("TCS.BO", chart, Date.UTC(2026, 9, 28));
    const series: PriceSeries = {
      instrument: { exchange: "BSE", code: "TCS" },
      providerSymbol: "TCS.BO",
      currency: parsed.currency,
      adjustment: { close: "split-adjusted", adjClose: "split-and-dividend" },
      sessionOpen: parsed.sessionOpen,
      bars: parsed.bars,
      source: { ...LIVE_REF, provider: "yahoo-chart", type: "market-data", url: "https://query1.finance.yahoo.com/v8/finance/chart/TCS.BO" },
      issues: [],
    };
    expect(PriceSeriesSchema.safeParse(series).success).toBe(true);
  });
});

/** A one-entry zip archive, as NSE publishes the bhavcopy. */
function zipOne(name: string, content: string): Uint8Array {
  const data = deflateRawSync(Buffer.from(content));
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(content), 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(content), 24);
  central.writeUInt16LE(file.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + file.length, 12);
  end.writeUInt32LE(30 + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

describe("NSE bhavcopy", () => {
  const header =
    "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";
  const csv = [
    header,
    // Real row from the 27 Oct 2026 file.
    "2026-10-27,2026-10-27,CM,NSE,STK,2885,INE002A01018,RELIANCE,EQ,,,,,RELIANCE INDUSTRIES LTD,1195.00,1202.60,1184.00,1196.20,1196.20,1201.80,,1196.22,,,13067787,15599937394.40,190852,F1,1,,,,,",
    "2026-10-27,2026-10-27,CM,NSE,STK,2885,INE002A01018,RELIANCE,BL,,,,,RELIANCE INDUSTRIES LTD,1190.00,1190.00,1190.00,1190.00,1190.00,1190.00,,1190.00,,,500,595000,1,F1,1,,,,,",
    "2026-10-27,2026-10-27,CM,NSE,STK,9999,INE000X01011,SMALLCO,BE,,,,,SMALL CO LTD,10.00,10.50,9.80,10.20,10.20,10.00,,10.20,,,1000,10200,12,F1,1,,,,,",
    "2026-10-27,2026-10-27,CM,NSE,FUT,1,,NIFTY,,2026-10-30,,,,NIFTY FUT,25000,25100,24900,25050,25050,25000,,25050,,,10,250500,1,F1,1,,,,,",
  ].join("\n");

  it("unzips the archive and parses equities, preferring the EQ series", () => {
    const parsed = parseBhavcopy(unzipFirst(zipOne("BhavCopy_NSE_CM_0_0_0_20261027_F_0000.csv", csv)), "2026-10-27");
    expect(parsed.rows.RELIANCE).toEqual([1195, 1202.6, 1184, 1196.2, 1201.8, 13_067_787]);
    expect(parsed.series.RELIANCE).toBe("EQ");
    expect(parsed.series.SMALLCO).toBe("BE");
    expect(parsed.rows.NIFTY).toBeUndefined();
  });

  it("refuses a file whose columns changed rather than misreading it", () => {
    expect(() => parseBhavcopy(csv.replace("ClsPric", "ClosePrice"), "2026-10-27")).toThrow(/columns changed/);
  });

  it("walks back over weekdays only", () => {
    // Wednesday 28 Oct 2026, 09:00 IST.
    expect(weekdaysBack(Date.UTC(2026, 9, 28, 3, 30), 4)).toEqual(["2026-10-28", "2026-10-27", "2026-10-26", "2026-10-23"]);
  });
});

describe("NSE announcements API", () => {
  const payload = [
    {
      an_dt: "27-Oct-2026 18:06:01",
      symbol: "HOMEFIRST",
      sm_name: "Home First Finance Company India Limited",
      desc: "Appointment",
      attchmntText: "Home First Finance Company India Limited has informed the Exchange about appointment of Chief Financial Officer",
      attchmntFile: "https://nsearchives.nseindia.com/corporate/HOMEFIRST_27102026180540_Outcome_of_BM_merged.pdf",
    },
    { an_dt: "27-Oct-2026 17:00:00", symbol: "HOMEFIRST", desc: "General Updates", attchmntFile: "-" },
    { an_dt: "not a date", symbol: "HOMEFIRST", desc: "Press Release", attchmntFile: "https://nsearchives.nseindia.com/corporate/x.pdf" },
  ];

  it("normalises rows and rejects (and reports) rows it cannot trust", () => {
    const { items, rejected } = parseAnnouncementsApi(payload, "HOMEFIRST");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ symbol: "HOMEFIRST", subject: "Appointment", ts: "2026-10-27T18:06:01+05:30", docType: "pdf", exchange: "NSE", via: "nse-api" });
    expect(rejected).toHaveLength(2);
    const record = { ...items[0], source: { ...LIVE_REF, provider: "nse-api", type: "exchange" as const, url: announcementsApiUrl("HOMEFIRST", "2026-10-21", "2026-10-28") } };
    expect(AnnouncementSchema.safeParse(record).success).toBe(true);
  });

  it("builds the documented query and treats a non-list answer as an error", () => {
    expect(announcementsApiUrl("M&M", "2026-10-21", "2026-10-28")).toBe(
      "https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=M%26M&from_date=21-10-2026&to_date=28-10-2026",
    );
    expect(() => parseAnnouncementsApi({ error: "blocked" }, "HOMEFIRST")).toThrow(/unexpected payload/);
  });
});

describe("screener.in normalisation", () => {
  const page = parseScreenerPage(fixture("screener-reliance-consolidated.html"), "RELIANCE", "consolidated");
  const f = toFundamentals(page, LIVE_REF);

  it("lists primary documents with their host and discovery source", () => {
    const docs = documentsFrom(page, LIVE_REF);
    for (const d of docs) expect(PrimarySourceSchema.safeParse(d).success).toBe(true);
    const ar = docs.find((d) => d.kind === "annual_report")!;
    expect(ar).toMatchObject({ id: "ar-2026", period: "FY26", host: "BSE", retrieval: { status: "not_fetched" } });
    const transcript = docs.find((d) => d.kind === "transcript")!;
    expect(transcript).toMatchObject({ date: "2026-07", title: "Earnings-call transcript, Jul 2026" });
    expect(transcript.period).toMatch(/^Q\d FY\d\d$/);
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
    expect(new Set(docs.map((d) => d.url)).size).toBe(docs.length);
  });

  it("flattens statements into canonical period values with units and section links", () => {
    const values = periodValues(f);
    for (const v of values.slice(0, 50)) expect(PeriodValueSchema.safeParse(v).success).toBe(true);
    const at = (metric: string) => values.find((v) => v.statement === "quarterly" && v.metric === metric && v.period.end === "2026-06-30");
    expect(at("revenue")).toMatchObject({ value: 309468, unit: "INR_cr", label: "sales", basis: "consolidated" });
    expect(at("ebitda")?.value).toBe(47517);
    expect(at("pat")?.value).toBe(23196);
    expect(at("revenue")?.source.url).toMatch(/#quarters$/);
    expect(values.find((v) => v.statement === "annual" && v.period.key === "TTM")?.period.end).toBeUndefined();
  });

  it("assigns units from the row, not the table", () => {
    expect(unitOf("opm %", "₹ crore")).toBe("%");
    expect(unitOf("debtor days", "₹ crore")).toBe("days");
    expect(unitOf("eps in rs", "₹ crore")).toBe("INR");
    expect(unitOf("sales", "₹ lakh")).toBe("INR_lakh");
  });

  it("produces a valid company record and only cited claims", () => {
    expect(CompanySchema.safeParse(f.company).success).toBe(true);
    const fin = analyzeFinancials(f);
    const claims = [...fin.headline, ...fin.trajectory.claims, ...fin.balanceSheet.claims, ...fin.cash.claims, ...fin.workingCapital.claims];
    expect(claims.length).toBeGreaterThan(3);
    for (const c of claims) expect(ResearchClaimSchema.safeParse(c).success).toBe(true);
    expect(ResearchClaimSchema.safeParse({ ...claims[0], citations: [] }).success).toBe(false);
  });
});

describe("alert rules", () => {
  it("round-trips settings through validated canonical rules", () => {
    const rules = rulesFromSettings(DEFAULT_THRESHOLDS, DEFAULT_ALERT_CATEGORIES);
    for (const r of rules) expect(AlertRuleSchema.safeParse(r).success).toBe(true);
    expect(thresholdsFromRules(rules)).toEqual(DEFAULT_THRESHOLDS);
    expect(alertCategoriesFromRules(rules).sort()).toEqual([...DEFAULT_ALERT_CATEGORIES].sort());
    expect(rules.find((r) => r.id === "filing:dividend")).toMatchObject({ enabled: false });
  });

  it("rejects thresholds outside the allowed range", () => {
    expect(() => rulesFromSettings({ pricePct: 0, volumeMultiple: 2, lookback: 20 }, [])).toThrow();
    expect(() => rulesFromSettings({ pricePct: 4, volumeMultiple: 2, lookback: 500 }, [])).toThrow();
  });
});

describe("demo seed", () => {
  let dir: string;
  const capturedAt = "2026-10-28T03:46:00.000Z";

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "finn-seed-"));
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ capturedAt, portfolio: ["RELIANCE"], researchPicks: [] }));
    writeFileSync(path.join(dir, "nse-equity-list.csv"), fixture("nse-equity-sample.csv"));
    writeFileSync(
      path.join(dir, "market.json"),
      JSON.stringify({
        asOf: capturedAt,
        // An older capture: bars without adjClose, keyed by bare NSE symbol.
        series: { RELIANCE: { symbol: "RELIANCE", currency: "INR", sessionOpen: false, bars: [{ date: "2026-10-26", open: 1200, high: 1210, low: 1195, close: 1201.8, volume: 9_000_000 }, { date: "2026-10-27", open: 1195, high: 1202.6, low: 1184, close: 1196.2, volume: 13_067_787 }] } },
      }),
    );
    writeFileSync(
      path.join(dir, "filings-archive.json"),
      JSON.stringify({
        version: 1,
        updatedAt: capturedAt,
        pulls: [{ fetchedAt: capturedAt, from: "2026-10-27T00:00:00+05:30", symbols: ["RELIANCE"] }],
        items: [
          { id: "https://nsearchives.nseindia.com/corporate/RIL_1.pdf", symbol: "RELIANCE", companyName: "Reliance Industries Limited", subject: "Press Release", description: "", url: "https://nsearchives.nseindia.com/corporate/RIL_1.pdf", docType: "pdf", ts: "2026-10-27T22:11:29+05:30", exchange: "NSE", via: "archive" },
        ],
      }),
    );
    writeFileSync(path.join(dir, "fundamentals.json"), JSON.stringify({ capturedAt, companies: { RELIANCE: parseScreenerPage(fixture("screener-reliance-consolidated.html"), "RELIANCE", "consolidated") } }));
  });

  it("labels every record as demo data with the capture time", async () => {
    const seed = seedProviders("demo", dir);
    const series = await seed.prices.dailySeries({ exchange: "NSE", code: "RELIANCE" });
    expect(series.source).toMatchObject({ provider: "demo-seed-prices", type: "demo", mode: "demo", retrievedAt: capturedAt });
    expect(series.bars.at(-1)).toMatchObject({ close: 1196.2, adjClose: null });
    expect(PriceSeriesSchema.safeParse(series).success).toBe(true);

    const directory = await seed.directory.load();
    const batch = await seed.announcements.recent({ symbols: ["RELIANCE"], from: Date.parse(capturedAt) - 86_400_000, to: Date.parse(capturedAt), directory });
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].source.mode).toBe("demo");
    expect(batch.coverage.RELIANCE).toEqual([{ from: Date.parse("2026-10-27T00:00:00+05:30"), to: Date.parse(capturedAt) }]);

    const f = await seed.fundamentals.company("RELIANCE");
    expect(f.source.mode).toBe("demo");
    expect(f.documents.every((d) => d.discoveredVia.mode === "demo")).toBe(true);
    expect((await seed.manifest())?.capturedAt).toBe(capturedAt);
  });

  it("is deterministic and says plainly when a symbol is not in the dataset", async () => {
    const a = await seedProviders("demo", dir).prices.dailySeries({ exchange: "NSE", code: "RELIANCE" });
    const b = await seedProviders("demo", dir).prices.dailySeries({ exchange: "NSE", code: "RELIANCE" });
    expect(a).toEqual(b);
    await expect(seedProviders("demo", dir).prices.dailySeries({ exchange: "NSE", code: "IRCTC" })).rejects.toBeInstanceOf(NoDataError);
    await expect(seedProviders("demo", dir).prices.dailySeries({ exchange: "BSE", code: "RELIANCE" })).rejects.toThrow(/RELIANCE\.BO is not in the demo dataset/);
  });

  it("is labelled snapshot, not demo, when used as the live fallback", async () => {
    const series = await seedProviders("snapshot", dir).prices.dailySeries({ exchange: "NSE", code: "RELIANCE" });
    expect(series.source).toMatchObject({ provider: "snapshot-prices", type: "market-data", mode: "snapshot" });
  });
});

describe("provider chain and health", () => {
  afterEach(() => resetHealth());

  const series = (provider: string): PriceSeries => ({
    instrument: { exchange: "NSE", code: "RELIANCE" },
    providerSymbol: "RELIANCE.NS",
    currency: "INR",
    adjustment: { close: "split-adjusted", adjClose: null },
    sessionOpen: false,
    bars: Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, open: null, high: null, low: null, close: 100 + i, adjClose: null, volume: 1000 })),
    source: { ...LIVE_REF, provider, type: "market-data" },
    issues: [],
  });
  const provider = (id: string, run: () => Promise<PriceSeries>): PriceProvider => ({ id, label: id, kind: "prices", supports: () => true, dailySeries: run });
  const setOf = (prices: PriceProvider[]): ProviderSet => ({ mode: "live", prices, announcements: [], fundamentals: [], directory: [], seed: seedProviders("snapshot", tmpdir()) });

  it("falls through to the next provider and records which one failed", async () => {
    const down = provider("down", () => Promise.reject(new Error("connect ETIMEDOUT")));
    const up = provider("up", () => Promise.resolve(series("up")));
    const got = await getPrices({ exchange: "NSE", code: "RELIANCE" }, undefined, setOf([down, up]));
    expect(got.source.provider).toBe("up");
    const [h1, h2] = healthOf([down, up]);
    expect(h1).toMatchObject({ status: "down", failures: 1, lastError: "connect ETIMEDOUT" });
    expect(h2).toMatchObject({ status: "ok", calls: 1, failures: 0 });
  });

  it("separates 'no data for this symbol' from a failing provider", async () => {
    const empty = provider("empty", () => Promise.reject(new NoDataError("no such symbol")));
    const err = await getPrices({ exchange: "NSE", code: "NOPE" }, undefined, setOf([empty])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataUnavailableError);
    expect((err as DataUnavailableError).noData).toBe(true);
    expect(healthOf([empty])[0]).toMatchObject({ status: "ok", failures: 0 });
  });

  it("flags a stale answer as degraded", async () => {
    const stale = provider("stale", () => Promise.resolve({ ...series("stale"), source: { ...series("stale").source, mode: "stale", note: "Live fetch failed (timeout); served the last good copy" } }));
    await getPrices({ exchange: "NSE", code: "RELIANCE" }, undefined, setOf([stale]));
    expect(healthOf([stale])[0]).toMatchObject({ status: "degraded", degradedBecause: expect.stringMatching(/last good copy/) });
  });

  it("reads the run mode from the environment, defaulting to live", () => {
    const before = process.env.FINN_DATA_MODE;
    process.env.FINN_DATA_MODE = "demo";
    expect(runMode()).toBe("demo");
    process.env.FINN_DATA_MODE = "something-else";
    expect(runMode()).toBe("live");
    if (before === undefined) delete process.env.FINN_DATA_MODE;
    else process.env.FINN_DATA_MODE = before;
  });
});
