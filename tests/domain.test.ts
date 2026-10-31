import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, roleRank, type Classification } from "@/lib/domain/classify";
import { DEFAULT_ALERT_CATEGORIES, type Category } from "@/lib/domain/categories";
import { filingMateriality } from "@/lib/domain/materiality";
import {
  appointmentFromText,
  boardMeetingDate,
  dividendInfo,
  findDate,
  informativeText,
  recordDateInfo,
  resultsPeriodEnd,
} from "@/lib/domain/extract";
import { cagr, change, formatInr, pctChange } from "@/lib/domain/numbers";
import { isQuarterEnd, lastCompletedQuarter, quarterDiscussedOnCall, quarterOf, shiftQuarter } from "@/lib/domain/periods";
import { resultsSnapshot, toCroreFactor } from "@/lib/domain/results";
import { computeSignal, DEFAULT_THRESHOLDS, type Bar } from "@/lib/domain/signals";
import { displayName } from "@/lib/domain/names";
import { interpretXbrl } from "@/lib/sources/xbrl";
import { parseScreenerPage } from "@/lib/sources/screener";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const alerts = new Set(DEFAULT_ALERT_CATEGORIES);
/** Ranking with neutral extras (two days old, no magnitude, high confidence), so only category and the alert list count. */
const prioritize = (c: Classification, watch: ReadonlySet<Category>) =>
  filingMateriality({ classification: c, ageHours: 48, onAlertList: watch.has(c.category), confidence: { level: "high", reasons: [] } });

describe("classification", () => {
  it("recognises a results filing from the board-meeting outcome", () => {
    const c = classify("Outcome of Board Meeting", "Cipla Limited has submitted to the Exchange, the financial results for the period ended September 30, 2026.");
    expect(c).toMatchObject({ category: "results", subtype: "results_filed", score: 90 });
  });

  it("treats a results date as informational, not an alert", () => {
    const c = classify("Board Meeting Intimation", "PB Fintech Limited has informed the Exchange about Board Meeting to be held on 30-Oct-2026 to consider and approve the Half Yearly Unaudited Financial results");
    expect(c.subtype).toBe("results_scheduled");
    expect(prioritize(c, alerts)).toMatchObject({ triggered: false, tier: "look" });
  });

  it("buries compliance paperwork", () => {
    for (const subject of ["Trading Window", "Trading Window-XBRL", "Certificate under SEBI (Depositories and Participants) Regulations, 2018", "Copy of Newspaper Publication"]) {
      const c = classify(subject, "");
      expect(prioritize(c, alerts).tier).toBe("routine");
    }
  });

  it("reads rating direction from the description", () => {
    expect(classify("Credit Rating- Revision", "Upward Revision in Issuer Rating by Care Edge").subtype).toBe("rating_up");
    expect(classify("Credit Rating", "Rating downgraded to AA- by CRISIL").score).toBe(85);
    expect(classify("Credit Rating", "ICRA has reaffirmed the rating").subtype).toBe("rating_affirm");
  });

  it("uses XBRL roles over the generic subject line", () => {
    const cfo = interpretXbrl(fixture("xbrl-homefirst-cfo-appointment.xml")).details;
    expect(classify("Change in Directors/KMP/SMP/Auditor/RTA", "", cfo)).toMatchObject({ subtype: "mgmt_key", score: 80 });
    const smp = interpretXbrl(fixture("xbrl-syngene-cessations.xml")).details;
    const c = classify("Change in Management", "Syngene International Limited has informed the Exchange about change in Management", smp);
    expect(c).toMatchObject({ subtype: "mgmt_other", score: 35 });
    expect(prioritize(c, alerts).triggered).toBe(false);
  });

  it("reads the role from the description when there is no XBRL", () => {
    expect(classify("Appointment", "Appointment of Ms Rinkoo Somani as Chief Financial Officer of the company w.e.f. October 27, 2026.").subtype).toBe("mgmt_key");
    expect(classify("Change in Directors/KMP/SMP/Auditor/RTA", "X has informed the Exchange about Change in Directors/KMP/SMP/Auditor/RTA").subtype).toBe("mgmt_unknown");
  });

  it("ranks roles by seniority", () => {
    expect(roleRank("Managing Director & CEO")).toBeGreaterThan(roleRank("Chief Financial Officer"));
    expect(roleRank("Chief Financial Officer")).toBeGreaterThan(roleRank("Independent Director"));
    expect(roleRank("President - Lighting")).toBeLessThan(roleRank("Independent Director"));
    expect(roleRank("Company Secretary")).toBeLessThan(roleRank("Head of Chemistry"));
  });

  it("does not mistake ESOP allotments for fund raises", () => {
    const capital = { kind: "capital" as const, capital: { issuanceType: "ESOP/ESPS" } };
    expect(classify("Alteration Of Capital and Fund Raising-XBRL", "Allotment of Securities", capital)).toMatchObject({ category: "unclassified", subtype: "esop" });
    const qip = { kind: "capital" as const, capital: { issuanceType: "Qualified Institutions Placement" } };
    expect(classify("Alteration Of Capital and Fund Raising-XBRL", "Allotment of Securities", qip).subtype).toBe("equity_raise");
    expect(classify("General Updates", "The grant of 54,100 Options to the eligible employees").subtype).toBe("esop");
  });

  it("finds earnings-call items hiding under generic subjects", () => {
    expect(classify("General Updates", "Audio Recording of the investors' call held on 27th October 2026.").subtype).toBe("call_recording");
    expect(classify("Analysts/Institutional Investor Meet/Con. Call Updates", "has filed with exchange transcript of earnings conference call").subtype).toBe("call_transcript");
  });

  it("separates deals, new subsidiaries and deal updates", () => {
    expect(classify("Acquisition", "Acquisition of 51% stake in XYZ Private Limited").subtype).toBe("ma_new");
    expect(classify("Acquisition of 'to be incorporated company'", "Incorporation of Wholly Owned Subsidiary").subtype).toBe("ma_subsidiary");
    const update = { kind: "deal" as const, deal: { update: "Transaction Completed", eventType: "Acquisition (including agreement to acquire)" } };
    const c = classify("Update-Acquisition (including agreement to acquire)", "", update);
    expect(c.subtype).toBe("ma_update");
    expect(c.reasons[0]).toBe("Deal update: transaction completed");
  });

  it("flags order wins", () => {
    expect(classify("Bagging/Receiving of orders/contracts  (Sub-para 4-Para B)", "").subtype).toBe("order_win");
  });
});

describe("prioritisation", () => {
  it("puts any material filing of a watched type in Needs attention", () => {
    const board = classify("Appointment", "Appointment of Ms Rashmi Joshi as Independent Director of the company");
    expect(prioritize(board, alerts)).toMatchObject({ tier: "attention", triggered: true, score: 65 });
    expect(prioritize(board, new Set())).toMatchObject({ tier: "look", triggered: false, score: 55 });
  });

  it("never triggers on routine filings, even in a watched category", () => {
    const ad = classify("Copy of Newspaper Publication", "Copy of Newspaper Publication of Un-audited financial results");
    expect(ad.category).toBe("results");
    expect(prioritize(ad, alerts)).toMatchObject({ triggered: false, tier: "routine" });
  });
});

describe("description extraction", () => {
  it("parses the date formats filings use", () => {
    expect(findDate("held on 30-Oct-2026")).toBe("2026-10-30");
    expect(findDate("on October 30, 2026")).toBe("2026-10-30");
    expect(findDate("on 30th September, 2026")).toBe("2026-09-30");
    expect(findDate("dated 30.09.2026")).toBe("2026-09-30");
  });

  it("finds the results period, falling back to the last completed quarter", () => {
    expect(resultsPeriodEnd("financial results for the period ended September 30, 2026", "2026-10-27T18:00:00+05:30")).toBe("2026-09-30");
    expect(resultsPeriodEnd("results for the quarter and nine months ended 31st December 2026", "2027-01-20T18:00:00+05:30")).toBe("2026-12-31");
    expect(resultsPeriodEnd("Outcome of board meeting", "2026-10-27T18:00:00+05:30")).toBe("2026-09-30");
    expect(resultsPeriodEnd("Outcome", "2026-05-05T18:00:00+05:30")).toBe("2026-03-31");
  });

  it("reads board-meeting dates, dividends and record dates", () => {
    expect(boardMeetingDate("Board Meeting to be held on 30-Oct-2026 to consider results")).toBe("2026-10-30");
    expect(dividendInfo("declared Interim Dividend of Rs. 7.70 per equity share")).toEqual({ kind: "Interim", perShare: 7.7 });
    expect(recordDateInfo("Record date for the purpose of Buyback  is 13-Nov-2026.")).toEqual({ purpose: "Buyback", date: "2026-11-13" });
  });

  it("extracts appointees and cleans doubled salutations", () => {
    expect(appointmentFromText("Appointment of Ms Rinkoo Somani as Chief Financial Officer of the company w.e.f. October 27, 2026.")).toEqual({
      name: "Ms Rinkoo Somani",
      role: "Chief Financial Officer",
    });
    expect(appointmentFromText("Appointment of Mr Mr. Santosh Kumar Singh as Other of the company w.e.f. October 27, 2026.")).toEqual({
      name: "Mr. Santosh Kumar Singh",
      role: "Not specified",
    });
  });

  it("drops boilerplate that only restates the subject", () => {
    expect(informativeText("Star Health has informed the Exchange about Investor Presentation", "Investor Presentation")).toBeNull();
    expect(informativeText("X has informed the Exchange regarding Change in Director(s) of the company.", "Change in Director(s)")).toBeNull();
    expect(informativeText("Gravita India Limited has informed the Exchange that Board of Directors declared Interim Dividend of Rs. 7.70", "Dividend")).toBe(
      "Board of Directors declared Interim Dividend of Rs. 7.70",
    );
  });

  it("shortens official names for display", () => {
    expect(displayName("ETERNAL LIMITED")).toBe("Eternal");
    expect(displayName("Larsen & Toubro Limited")).toBe("Larsen & Toubro");
  });
});

describe("fiscal periods", () => {
  it("maps quarter ends to Indian fiscal quarters", () => {
    expect(quarterOf("2026-09-30")).toMatchObject({ fy: 2027, q: 2, label: "Q2 FY27" });
    expect(quarterOf("2027-03-31")).toMatchObject({ fy: 2027, q: 4, label: "Q4 FY27" });
    expect(quarterOf("2026-08-31")).toBeNull();
  });

  it("shifts quarters across year boundaries", () => {
    expect(shiftQuarter("2026-09-30", -1)).toBe("2026-06-30");
    expect(shiftQuarter("2026-03-31", -1)).toBe("2025-12-31");
    expect(shiftQuarter("2026-09-30", -4)).toBe("2025-09-30");
    expect(shiftQuarter("2025-12-31", 1)).toBe("2026-03-31");
  });

  it("knows which quarter a call discussed", () => {
    expect(lastCompletedQuarter(new Date("2026-10-27T12:00:00Z"))).toBe("2026-09-30");
    expect(quarterDiscussedOnCall("2026-07")?.label).toBe("Q1 FY27");
    expect(quarterDiscussedOnCall("2026-05")?.label).toBe("Q4 FY26");
  });
});

describe("arithmetic", () => {
  it("describes changes honestly around zero and losses", () => {
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(change(-5, 10)).toEqual({ kind: "turned_negative" });
    expect(change(5, -10)).toEqual({ kind: "turned_positive" });
    expect(change(-5, -10)).toEqual({ kind: "loss_narrowed", value: 5 });
    expect(change(-15, -10)).toEqual({ kind: "loss_widened", value: -5 });
    expect(change(5, 0)).toEqual({ kind: "na", reason: "zero-base" });
    expect(change(null, 5)).toEqual({ kind: "na", reason: "missing" });
  });

  it("computes CAGR and refuses non-positive bases", () => {
    expect(cagr(100, 121, 2)).toBeCloseTo(10);
    expect(cagr(-100, 121, 2)).toBeNull();
  });

  it("formats rupee amounts", () => {
    expect(formatInr(98536500)).toBe("₹9.85 cr");
    expect(formatInr(982000000)).toBe("₹98.20 cr");
    expect(formatInr(42_000_000_000)).toBe("₹4,200 cr");
    expect(formatInr(5_000_000)).toBe("₹50.0 lakh");
  });
});

function bars(closes: number[], volumes?: number[], start = "2026-01-01"): Bar[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return closes.map((close, i) => ({
    date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    open: close,
    high: close,
    low: close,
    close,
    volume: volumes?.[i] ?? 1000,
  }));
}

describe("price and volume rules", () => {
  const t = DEFAULT_THRESHOLDS;

  it("fires on a move beyond the investor's threshold", () => {
    const s = computeSignal(bars([...Array(25).fill(100), 95]), t, { sessionOpen: false });
    expect(s?.changePct).toBeCloseTo(-5);
    expect(s?.hits.map((h) => h.id)).toEqual(["price"]);
  });

  it("fires on volume against the trailing average, excluding the day itself", () => {
    const s = computeSignal(bars(Array(26).fill(100), [...Array(25).fill(1000), 2500]), t, { sessionOpen: false });
    expect(s?.volumeRatio).toBeCloseTo(2.5);
    expect(s?.hits.map((h) => h.id)).toEqual(["volume"]);
  });

  it("respects a custom threshold", () => {
    const series = bars([...Array(25).fill(100), 97]);
    expect(computeSignal(series, t, { sessionOpen: false })?.hits).toHaveLength(0);
    expect(computeSignal(series, { ...t, pricePct: 2 }, { sessionOpen: false })?.hits.map((h) => h.id)).toEqual(["price"]);
  });

  it("ignores today's partial bar while the session is open", () => {
    const now = Date.parse("2026-01-26T06:00:00Z");
    const series = bars([...Array(25).fill(100), 80], [...Array(25).fill(1000), 100]);
    const s = computeSignal(series, t, { sessionOpen: true, now });
    expect(s?.excludedPartialSession).toBe(true);
    expect(s?.date).toBe("2026-01-25");
    expect(s?.hits).toHaveLength(0);
  });

  it("detects a 52-week high and needs enough history to say so", () => {
    const rising = bars([...Array(240).fill(100), 120]);
    expect(computeSignal(rising, t, { sessionOpen: false })?.hits.map((h) => h.id)).toContain("high52");
    expect(computeSignal(bars([...Array(30).fill(100), 101]), t, { sessionOpen: false })?.hits).toHaveLength(0);
    expect(computeSignal(bars([100]), t, { sessionOpen: false })).toBeNull();
  });

  it("counts a session sent twice once, so the day is not compared with itself", () => {
    const series = bars([...Array(25).fill(100), 104]);
    // The provider repeats the last session (same date, same close): the move is still +4% on the day before.
    const twice = [...series, { ...series[series.length - 1] }];
    const s = computeSignal(twice, t, { sessionOpen: false })!;
    expect(s.prevClose).toBe(100);
    expect(s.changePct).toBeCloseTo(4);
    expect(s.hits.map((h) => h.id)).toEqual(["price"]);
    // A later copy of the session (say, the live close after an early print) replaces the earlier one.
    const revised = [...series.slice(0, -1), { ...series[series.length - 1], close: 101 }, { ...series[series.length - 1], close: 104.5 }];
    expect(computeSignal(revised, t, { sessionOpen: false })!.close).toBe(104.5);
  });

  it("stays silent rather than guess when history is missing", () => {
    // Last session's volume missing: no volume rule, and no crash.
    const noVol = bars(Array(26).fill(100)).map((b, i, all) => (i === all.length - 1 ? { ...b, volume: null } : b));
    expect(computeSignal(noVol, t, { sessionOpen: false })).toMatchObject({ volumeRatio: null, hits: [] });
    // Fewer than five earlier sessions with volume: no average to compare against.
    const thin = bars([100, 100, 100, 100, 100], [0, 0, 0, 1000, 9000]);
    expect(computeSignal(thin, t, { sessionOpen: false })).toMatchObject({ avgVolume: null, volumeRatio: null });
    // A zero previous close gives no percentage, so no price rule fires off it.
    expect(computeSignal(bars([...Array(20).fill(100), 0, 50]), t, { sessionOpen: false })).toMatchObject({ changePct: null });
  });
});

describe("period and unit inputs", () => {
  it("accepts only real quarter-end dates", () => {
    expect(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"].every(isQuarterEnd)).toBe(true);
    expect(["2026-09-31", "2026-09-01", "2026-06-31", "2026-13-31", "garbage", "", "2026-9-30"].some(isQuarterEnd)).toBe(false);
  });

  it("converts the unit spellings Indian filings use to ₹ crore, and admits not knowing the rest", () => {
    expect(["₹ crore", "Rs. in Crores", "Rs. in Lakhs", "Rs. in Lacs", "₹ in lacs", "₹ Million", "Rs. in Thousands", "INR"].map(toCroreFactor)).toEqual([1, 1, 0.01, 0.01, 0.01, 0.1, 1e-4, 1e-7]);
    expect(toCroreFactor("USD million")).toBe(0.1);
    expect(toCroreFactor("tonnes")).toBeNull();
  });
});

describe("results headline numbers", () => {
  it("computes QoQ and YoY for an operating company", () => {
    const rel = parseScreenerPage(fixture("screener-reliance-consolidated.html"), "RELIANCE", "consolidated");
    const r = resultsSnapshot(rel, "2026-06-30");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.quarter.label).toBe("Q1 FY27");
    const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
    expect(Object.keys(byKey)).toEqual(["revenue", "ebitda", "pbt", "pat"]);
    expect(byKey.revenue.current).toBe(309468);
    expect(byKey.revenue.prevQuarter).toBe(294059);
    expect(byKey.revenue.qoq).toMatchObject({ kind: "pct" });
    if (byKey.revenue.qoq.kind === "pct") expect(byKey.revenue.qoq.value).toBeCloseTo(5.24, 2);
    if (byKey.ebitda.qoq.kind === "pct") expect(byKey.ebitda.qoq.value).toBeCloseTo(7.648, 2);
    if (byKey.pat.qoq.kind === "pct") expect(byKey.pat.qoq.value).toBeCloseTo(12.662, 2);
    expect(byKey.revenue.yoy.kind).toBe("pct");
    expect(r.comparedWith.yearAgo).toBe("2025-06-30");
  });

  it("uses net interest income instead of EBITDA for lenders", () => {
    const hf = parseScreenerPage(fixture("screener-homefirst-standalone.html"), "HOMEFIRST", "standalone");
    const r = resultsSnapshot(hf, "2026-09-30");
    if (r.status !== "ok") throw new Error("expected ok");
    const nii = r.metrics.find((m) => m.key === "nii")!;
    expect(r.metrics.find((m) => m.key === "ebitda")).toMatchObject({ status: "not-applicable", current: null });
    expect(nii).toMatchObject({ current: 342, prevQuarter: 330, yearAgo: 274 });
    if (nii.yoy.kind === "pct") expect(nii.yoy.value).toBeCloseTo(24.82, 1);
  });

  it("says when screener has not published the quarter yet", () => {
    const rel = parseScreenerPage(fixture("screener-reliance-consolidated.html"), "RELIANCE", "consolidated");
    expect(resultsSnapshot(rel, "2026-09-30")).toMatchObject({ status: "quarter-missing", latestAvailable: "2026-06-30" });
  });
});
