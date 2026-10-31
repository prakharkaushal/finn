import { describe, expect, it } from "vitest";
import {
  candidateScore,
  dedupeStatements,
  detectRevisions,
  evaluate,
  isSegmentScoped,
  parseGuidance,
  parsePeriod,
} from "@/lib/research/guidance";
import { quoteAppears, transcriptSentences } from "@/lib/research/transcript";
import type { GuidanceStatement } from "@/lib/research/types";
import type { FinTable, ScreenerCompany } from "@/lib/sources/screener";

// Real sentences from Q2 FY26 – Q2 FY27 earnings-call transcripts that the parser once got wrong.
const PIDILITE_CORRIDOR = "Now the question is, and our desire rate to continue to maintain this growth because for us, the EBITDA corridor which we have shared is 20% to 24%.";
const KAYNES_ADMISSION =
  "I think these are the 2 things that while we have delivered about 33% growth in revenue and 39% growth in the bottom line, we sincerely understand and appreciate that the guidance what we have given, we could not meet.";
const KAYNES_FY26 =
  "At the start of the year, sir, we had guided that we are looking to close the year with revenues of INR4,500 crores, which was subsequently toned down to INR4,000 crores, and we ended the year with close to INR3,600 crores of revenue, sir.";
const KAYNES_SEGMENT = "You guided for the full year, the smart metering business should do around INR700 crores to INR800 crores of revenue.";
const COFORGE_RAISE = "We are pleased to raise our consolidated EBIT margin guidance for fiscal year 2027 to 16%, from the 15.5% we had shared at the beginning of the year.";
const COFORGE_UPGRADE = "As Saurabh stated, ladies and gentlemen, we are upgrading our FY2027 consolidated EBIT margin guidance from 15.5% to 16%.";
const COFORGE_BULLETS =
  "With Q4 FY26 EBITDA margins at 20.5% and EBIT margins at 16.6%, we are confident of achieving: • EBITDA margins of 20.5% to 21% in FY27 on a consolidated basis, which is including Encora and, • EBIT margins of 16.5% to 17% on a standalone basis, that is, excluding Encora.";
const COFORGE_Q4 = "EPS with no exceptional expenses in Q3 going forward lower hedge losses in Q3 and almost negligible in Q4, improvement in EBIT margin in Q4 to 17%.";
const COFORGE_HEDGE = "Just to mention, if you add back the hedge losses against revenue in the current quarter, the EBIT margin was 15.2% against our guidance of 15%.";

describe("guidance parsing on real transcript sentences", () => {
  it("reads a margin corridor", () => {
    expect(parseGuidance(PIDILITE_CORRIDOR)).toMatchObject([{ metric: "ebitda_margin", low: 20, high: 24, unit: "%" }]);
  });

  it("does not mistake delivered results for promises", () => {
    expect(parseGuidance(KAYNES_ADMISSION)).toEqual([]);
  });

  it("reads an absolute revenue target and anchors retrospective talk to the year just ended", () => {
    const [p] = parseGuidance(KAYNES_FY26);
    expect(p).toMatchObject({ metric: "revenue_target", low: 4500, high: 4500, unit: "INR_cr" });
    expect(parsePeriod(KAYNES_FY26, "2026-05", p.at)?.label).toBe("FY26");
  });

  it("keeps segment-level targets out of company-wide checks", () => {
    expect(parseGuidance(KAYNES_SEGMENT)).toMatchObject([{ metric: "revenue_target", low: 700, high: 800, segment: true }]);
    expect(isSegmentScoped(KAYNES_SEGMENT)).toBe(true);
    expect(isSegmentScoped(COFORGE_RAISE)).toBe(false);
  });

  it("treats a named brand or subsidiary in the number's clause as segment-level", () => {
    const titan = "So I expect that overall margin, we had -- if you remember, a couple of quarters back, we had said that, gradually, CaratLane with the scale will start inching towards double-digit EBIT margin.";
    expect(parseGuidance(titan, "Titan Company")).toMatchObject([{ metric: "ebit_margin", low: 10, segment: true }]);
    expect(parseGuidance(COFORGE_RAISE, "Coforge")[0].segment).toBe(false);
    expect(parseGuidance(KAYNES_FY26, "Kaynes Technology India")[0].segment).toBe(false);
    expect(parseGuidance("Titan will deliver EBIT margin of 11% in FY27.", "Titan Company")[0].segment).toBe(false);
  });

  it("does not read a year as the start of a range, and takes the new number in a raise", () => {
    expect(parseGuidance(COFORGE_RAISE)).toMatchObject([{ metric: "ebit_margin", low: 16, high: 16 }]);
    expect(parseGuidance(COFORGE_UPGRADE)).toMatchObject([{ metric: "ebit_margin", low: 16, high: 16 }]);
    expect(parsePeriod(COFORGE_RAISE, "2026-10")?.label).toBe("FY27");
  });

  it("keeps EBIT and EBITDA apart, skips current levels and standalone-basis targets", () => {
    const parsed = parseGuidance(COFORGE_BULLETS);
    expect(parsed).toMatchObject([{ metric: "ebitda_margin", low: 20.5, high: 21 }]);
    expect(parsePeriod(COFORGE_BULLETS, "2026-05", parsed[0].at)?.label).toBe("FY27");
  });

  it("uses the period mentioned nearest to the number", () => {
    const [p] = parseGuidance(COFORGE_Q4);
    expect(p).toMatchObject({ metric: "ebit_margin", low: 17 });
    expect(parsePeriod(COFORGE_Q4, "2026-10", p.at)?.label).toBe("Q4 FY27");
  });

  it("separates an actual from the guidance it is compared against", () => {
    const [p] = parseGuidance(COFORGE_HEDGE);
    expect(p).toMatchObject({ metric: "ebit_margin", low: 15, high: 15 });
    expect(parsePeriod(COFORGE_HEDGE, "2026-05", p.at)?.label).toBe("Q4 FY26");
  });

  it("maps qualitative phrases to explicit, flagged ranges", () => {
    expect(parseGuidance("We expect mid-teens revenue growth in FY27.")).toMatchObject([{ metric: "revenue_growth", low: 14, high: 16, interpreted: true }]);
    const open = parseGuidance("We expect revenue growth of at least 20% next year.");
    expect(open[0]).toMatchObject({ metric: "revenue_growth", low: 20 });
    expect(open[0].high).toBeUndefined();
    expect(parsePeriod("We expect revenue growth of at least 20% next year.", "2026-07")?.label).toBe("FY28");
  });
});

describe("fiscal period resolution", () => {
  it("handles explicit forms", () => {
    expect(parsePeriod("margins of 18% in FY2026-27", "2026-07")?.label).toBe("FY27");
    expect(parsePeriod("growth of 15% in H2 FY27", "2026-07")?.label).toBe("H2 FY27");
    expect(parsePeriod("growth in 3Q FY27", "2026-07")?.label).toBe("Q3 FY27");
  });

  it("infers 'this year' from the call date, rolling over after a Q4 call", () => {
    expect(parsePeriod("we expect 15% growth", "2026-07")).toMatchObject({ label: "FY27", inferred: true });
    expect(parsePeriod("we expect 15% growth", "2026-05")).toMatchObject({ label: "FY27", inferred: true });
    expect(parsePeriod("we expect 15% growth", "2026-02")).toMatchObject({ label: "FY26", inferred: true });
  });
});

describe("transcript sentences", () => {
  const pages = [
    "Company Ltd\nQ2 FY27 Earnings Conference Call\nModerator: Good evening and welcome.",
    "Company Ltd\nRahul Sharma: Revenue grew 11.1% to Rs. 1,234 crores this quarter. We expect EBITDA margin of 18% to 19% for FY27.\nAnalyst: What is the outlook for margins next year?",
    "Company Ltd\nRahul Sharma: We remain confident of\ndelivering double-digit growth.",
    "Company Ltd\nModerator: Thank you.",
  ];
  const sentences = transcriptSentences(pages);

  it("keeps decimals and 'Rs.' inside sentences and drops repeated letterhead lines", () => {
    expect(sentences.some((s) => s.text === "Revenue grew 11.1% to Rs. 1,234 crores this quarter.")).toBe(true);
    expect(sentences.some((s) => s.text.includes("Company Ltd"))).toBe(false);
  });

  it("tracks speaker, page and questions, and joins lines broken mid-sentence", () => {
    const margin = sentences.find((s) => s.text.startsWith("We expect EBITDA margin"))!;
    expect(margin).toMatchObject({ page: 2, speaker: "Rahul Sharma", isQuestion: false });
    expect(sentences.find((s) => s.text.startsWith("What is the outlook"))).toMatchObject({ speaker: "Analyst", isQuestion: true });
    expect(sentences.find((s) => s.text.startsWith("We remain confident"))?.text).toBe("We remain confident of delivering double-digit growth.");
  });

  it("scores forward guidance above history and questions", () => {
    const by = (prefix: string) => sentences.find((s) => s.text.startsWith(prefix))!;
    expect(candidateScore(by("We expect EBITDA margin"))).toBeGreaterThanOrEqual(6);
    expect(candidateScore(by("Revenue grew 11.1%"))).toBeLessThan(6);
    expect(candidateScore(by("What is the outlook"))).toBe(0);
  });

  it("verifies quotes against their source", () => {
    expect(quoteAppears("EBITDA margin of 18% to 19%", pages.join(" "))).toBe(true);
    expect(quoteAppears("EBITDA margin of 22%", pages.join(" "))).toBe(false);
  });

  it("keeps a page's printed number out of a sentence that runs across the page break", () => {
    // As HCLTech's transcripts print it: letterhead, date, then the bare page number, one per line.
    const header = (n: number) => `Acme Instruments Limited\nOctober 12, 2026\n${n}`;
    const call = [
      "Acme Instruments Limited\nOctober 12, 2026\nEarnings conference call",
      `${header(1)}\nRavi Menon: Software revenue for the quarter is $313 million, representing growth`,
      `${header(2)}\nof 2.2% QoQ and decline of 5.3% YoY. We shipped 250\nunits to new customers.`,
      `${header(3)}\nRavi Menon: Thank you.`,
      `${header(4)}\nModerator: That concludes the call.`,
    ];
    const s = transcriptSentences(call);
    expect(s.find((x) => x.text.startsWith("Software revenue"))?.text).toBe("Software revenue for the quarter is $313 million, representing growth of 2.2% QoQ and decline of 5.3% YoY.");
    // A number that is part of the speech, not the page number, stays.
    expect(s.some((x) => x.text.includes("We shipped 250 units"))).toBe(true);
  });
});

function table(cols: [string, string][], rows: Record<string, (number | null)[]>): FinTable {
  return { periods: cols.map(([key, label]) => ({ key, label })), rows, order: Object.keys(rows) };
}

const company = (overrides: Partial<ScreenerCompany> = {}): ScreenerCompany => ({
  symbol: "TEST",
  name: "Test Co",
  url: "https://www.screener.in/company/TEST/",
  basis: "consolidated",
  isLender: false,
  units: "₹ crore",
  topRatios: [],
  annual: table(
    [["2025-03-31", "Mar 2025"], ["2026-03-31", "Mar 2026"]],
    { sales: [1000, 1150], "operating profit": [200, 241.5], depreciation: [40, 46], "net profit": [100, 120] },
  ),
  quarters: table(
    [["2025-06-30", "Jun 2025"], ["2025-09-30", "Sep 2025"], ["2026-06-30", "Jun 2026"], ["2026-09-30", "Sep 2026"]],
    { sales: [250, 260, 280, 290], "operating profit": [50, 52, 50, 52], depreciation: [10, 10, 11, 11], "net profit": [25, 26, 28, 29] },
  ),
  balanceSheet: table([], {}),
  cashFlow: table([], {}),
  ratios: table([], {}),
  announcements: [],
  annualReports: [],
  concalls: [],
  creditRatings: [],
  ...overrides,
});

const fy = (y: number) => ({ label: `FY${y % 100}`, fy: y, scope: "FY" as const, inferred: false });

describe("promised vs delivered", () => {
  const c = company();

  it("scores completed years against the guided range", () => {
    expect(evaluate({ metric: "revenue_growth", low: 14, high: 16, period: fy(2026), quote: "" }, c)).toMatchObject({ status: "delivered", actual: 15 });
    expect(evaluate({ metric: "revenue_growth", low: 18, high: 20, period: fy(2026), quote: "" }, c).status).toBe("missed");
    expect(evaluate({ metric: "revenue_growth", low: 8, high: 10, period: fy(2026), quote: "" }, c).status).toBe("beat");
    expect(evaluate({ metric: "ebitda_margin", low: 21, high: 22, period: fy(2026), quote: "" }, c)).toMatchObject({ status: "delivered", actual: 21 });
    expect(evaluate({ metric: "ebit_margin", low: 17, high: 17, period: fy(2026), quote: "" }, c)).toMatchObject({ status: "delivered", actual: 17 });
  });

  it("tracks a year in progress from the quarters reported so far", () => {
    const v = evaluate({ metric: "revenue_growth", low: 10, high: 12, period: fy(2027), quote: "" }, c);
    expect(v.status).toBe("on_track");
    expect(v.actual).toBeCloseTo(((280 + 290) / (250 + 260) - 1) * 100);
    expect(v.actualLabel).toMatch(/2 of 4 quarters/);
    expect(evaluate({ metric: "revenue_growth", low: 20, period: fy(2027), quote: "" }, c).status).toBe("behind");
  });

  it("checks absolute revenue targets, pro-rata while the year runs", () => {
    expect(evaluate({ metric: "revenue_target", low: 1200, high: 1200, unit: "INR_cr", period: fy(2026), quote: "" }, c)).toMatchObject({ status: "missed", actual: 1150 });
    expect(evaluate({ metric: "revenue_target", low: 1100, high: 1100, unit: "INR_cr", period: fy(2026), quote: "" }, c).status).toBe("beat");
    expect(evaluate({ metric: "revenue_target", low: 1100, high: 1100, unit: "INR_cr", period: fy(2027), quote: "" }, c).status).toBe("on_track");
    expect(evaluate({ metric: "revenue_target", low: 1400, high: 1400, unit: "INR_cr", period: fy(2027), quote: "" }, c).status).toBe("behind");
  });

  it("says pending, or not checkable, instead of guessing", () => {
    expect(evaluate({ metric: "revenue_growth", low: 10, period: fy(2028), quote: "" }, c).status).toBe("pending");
    expect(evaluate({ metric: "capex", low: 300, unit: "INR_cr", period: fy(2027), quote: "" }, c).status).toBe("not_comparable");
    expect(evaluate({ metric: "revenue_target", low: 700, high: 800, period: fy(2026), quote: KAYNES_SEGMENT }, c).status).toBe("not_comparable");
    expect(evaluate({ metric: "ebitda_margin", low: 20, period: fy(2026), quote: "" }, company({ isLender: true })).status).toBe("not_comparable");
  });
});

function stmt(partial: Partial<GuidanceStatement> & Pick<GuidanceStatement, "callMonth" | "low">): GuidanceStatement {
  return {
    id: `${partial.callMonth}-${partial.page ?? 1}-${partial.low}`,
    sourceId: `call-${partial.callMonth}`,
    callLabel: `${partial.callMonth} call`,
    page: 1,
    quote: "",
    metric: "ebit_margin",
    high: partial.low,
    unit: "%",
    period: fy(2027),
    structuredBy: "rules",
    ...partial,
  };
}

describe("guidance revisions", () => {
  it("tracks raises and cuts across calls using each call's stance", () => {
    const revisions = detectRevisions([
      stmt({ callMonth: "2026-05", low: 15.5 }),
      stmt({ callMonth: "2026-07", low: 15.5 }),
      stmt({ callMonth: "2026-10", low: 16, page: 2, quote: "We raise our guidance to 16%" }),
      stmt({ callMonth: "2026-10", low: 15.5, page: 6, quote: "above our current guidance of 15.5%" }),
    ]);
    expect(revisions.map((r) => r.direction)).toEqual(["maintained", "raised"]);
    expect(revisions[1]).toMatchObject({ from: "15.5%", to: "16%" });
  });

  it("counts a promise repeated within one call once", () => {
    const unique = dedupeStatements([stmt({ callMonth: "2026-10", low: 16, page: 2 }), stmt({ callMonth: "2026-10", low: 16, page: 10 })]);
    expect(unique).toHaveLength(1);
    expect(unique[0].page).toBe(2);
  });
});
