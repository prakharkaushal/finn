import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildIndex, nameKey, normalizeTicker, parseMasterCsv, searchCompanies } from "@/lib/sources/nse-master";
import { parseNseRss, parseNseTimestamp, splitDescription } from "@/lib/sources/nse-rss";
import { contextGroup, humanize, interpretXbrl } from "@/lib/sources/xbrl";
import { assertCompanyPage, parseCell, parseScreenerPage, rowKey } from "@/lib/sources/screener";
import { parseChart } from "@/lib/sources/yahoo";

describe("Yahoo daily bars", () => {
  const session = (d: number) => Date.UTC(2026, 9, d, 3, 45) / 1000; // 09:15 IST
  const chart = (marketTime: number) => ({
    chart: {
      result: [
        {
          meta: { currency: "INR", regularMarketPrice: 3420, regularMarketTime: marketTime, currentTradingPeriod: { regular: { start: session(28), end: session(28) + 22_500 } } },
          timestamp: [session(26), session(27)],
          indicators: { quote: [{ open: [3300, 3310], high: [3320, 3450], low: [3280, 3300], close: [3306.8, null], volume: [621_639, 1_542_434] }] },
        },
      ],
      error: null,
    },
  });

  it("fills a null latest close from the same session's last traded price", () => {
    const s = parseChart("KAYNES", chart(Date.UTC(2026, 9, 27, 9, 58) / 1000), Date.UTC(2026, 9, 27, 21, 0));
    expect(s.bars.at(-1)).toMatchObject({ date: "2026-10-27", close: 3420, volume: 1_542_434 });
    expect(s.sessionOpen).toBe(false);
  });

  it("does not borrow a price from a different session", () => {
    const s = parseChart("KAYNES", chart(Date.UTC(2026, 9, 26, 9, 58) / 1000), Date.UTC(2026, 9, 27, 21, 0));
    expect(s.bars.at(-1)?.date).toBe("2026-10-26");
  });
});

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const master = parseMasterCsv(fixture("nse-equity-sample.csv"));
const index = buildIndex(master);

describe("ticker normalisation", () => {
  it.each([
    ["reliance", "RELIANCE"],
    [" RELIANCE.NS ", "RELIANCE"],
    ["NSE:TCS", "TCS"],
    ["m&m.bo", "M&M"],
    ["bajaj-auto", "BAJAJ-AUTO"],
  ])("%s → %s", (input, symbol) => {
    expect(normalizeTicker(input)).toEqual({ ok: true, symbol });
  });

  it("rejects junk", () => {
    expect(normalizeTicker("").ok).toBe(false);
    expect(normalizeTicker("DROP TABLE;").ok).toBe(false);
    expect(normalizeTicker("<script>").ok).toBe(false);
  });
});

describe("NSE master list", () => {
  it("parses symbols, names and ISINs", () => {
    const lt = master.find((c) => c.symbol === "LT");
    expect(lt).toMatchObject({ name: "Larsen & Toubro Limited", isin: "INE018A01030", series: "EQ" });
  });

  it("matches feed names regardless of entity encoding, case and suffix", () => {
    expect(nameKey("Larsen &amp; Toubro Limited")).toBe(nameKey("LARSEN & TOUBRO LTD"));
    expect(index.byName.get(nameKey("ETERNAL LIMITED"))).toBe("ETERNAL");
  });

  it("ranks exact symbol above prefix and name matches", () => {
    const hits = searchCompanies(master, "hdfc");
    expect(hits[0].symbol).toBe("HDFCBANK");
    expect(searchCompanies(master, "TCS")[0].symbol).toBe("TCS");
    expect(searchCompanies(master, "larsen")[0].symbol).toBe("LT");
  });
});

describe("NSE announcements feed", () => {
  const pull = parseNseRss(fixture("nse-rss-sample.xml"), index);

  it("converts IST timestamps to ISO with offset", () => {
    expect(parseNseTimestamp("27-Oct-2026 22:21:09")).toBe("2026-10-27T22:21:09+05:30");
    expect(parseNseTimestamp("7-Nov-2026 09:05:00")).toBe("2026-11-07T09:05:00+05:30");
    expect(parseNseTimestamp("garbage")).toBeNull();
  });

  it("separates the exchange subject from the description", () => {
    expect(splitDescription("X has informed the Exchange about Y |SUBJECT: Credit Rating")).toEqual({
      description: "X has informed the Exchange about Y",
      subject: "Credit Rating",
    });
  });

  it("resolves symbols from official names, including XBRL items with no symbol in the URL", () => {
    const homefirst = pull.items.filter((i) => i.companyName.startsWith("Home First"));
    expect(homefirst.length).toBeGreaterThan(0);
    expect(homefirst.every((i) => i.symbol === "HOMEFIRST")).toBe(true);
    expect(homefirst.some((i) => i.docType === "xbrl")).toBe(true);
    const lt = pull.items.find((i) => i.companyName.includes("Larsen"));
    expect(lt?.symbol).toBe("LT");
  });

  it("reports the window it covers", () => {
    expect(pull.coverage).not.toBeNull();
    expect(Date.parse(pull.coverage!.from)).toBeLessThanOrEqual(Date.parse(pull.coverage!.to));
  });

  it("tolerates items without a description", () => {
    const xml = `<rss><channel><item><title>Infosys Limited</title><link>https://nsearchives.nseindia.com/corporate/INFY_1.pdf</link><pubDate>27-Oct-2026 10:00:00</pubDate></item></channel></rss>`;
    const { items } = parseNseRss(xml, index);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ symbol: "INFY", subject: "", description: "" });
  });
});

describe("Reg-30 XBRL", () => {
  it("groups D_/I_ contexts by person index", () => {
    expect(contextGroup("D_ChangeInManagement2")).toBe("ChangeInManagement2");
    expect(contextGroup("I_BaggingOrReceivingOfOrdersOrContractsMember")).toBe("BaggingOrReceivingOfOrdersOrContracts");
    expect(contextGroup("MainI")).toBe("Main");
  });

  it("reads an appointment with the company-disclosed brief profile", () => {
    const doc = interpretXbrl(fixture("xbrl-homefirst-cfo-appointment.xml"));
    expect(doc.symbol).toBe("HOMEFIRST");
    expect(doc.details.kind).toBe("management");
    if (doc.details.kind !== "management") return;
    const [person] = doc.details.people;
    expect(person).toMatchObject({
      name: "Ms. Rinkoo Somani",
      changeType: "Appointment",
      role: "Chief Financial Officer",
      roleCategory: "Key Managerial Personnel",
      effectiveDate: "2026-10-27",
    });
    expect(person.briefProfile).toMatch(/Chartered Accountant/);
  });

  it("reads multiple cessations and attaches resignation details by name", () => {
    const doc = interpretXbrl(fixture("xbrl-syngene-cessations.xml"));
    if (doc.details.kind !== "management") throw new Error("expected management");
    expect(doc.details.people.map((p) => p.name)).toEqual(["Mr. Ajay Tandon", "Mr. Subhendu Kumar", "Mr. Priyaranjan Pattanaik"]);
    const ajay = doc.details.people[0];
    expect(ajay).toMatchObject({ cessationCategory: "Resignation", role: "Head Strategy & Corporate Development" });
    expect(ajay.resignationLetterReceived).toBe("2026-10-23");
    expect(ajay.detailedReasonGiven).toBe(false);
    expect(doc.details.people[1].remarks).toBeUndefined();
  });

  it("reads an order win with value and counterparty", () => {
    const doc = interpretXbrl(fixture("xbrl-arisinfra-order.xml"));
    if (doc.details.kind !== "order") throw new Error("expected order");
    expect(doc.details.orders[0]).toMatchObject({
      counterparty: "S.P. Adke’s Construction",
      amountInr: 98536500,
      ordinaryCourse: true,
      relatedParty: false,
    });
  });

  it("reads an acquisition including related-party flags", () => {
    const doc = interpretXbrl(fixture("xbrl-sgmart-acquisition.xml"));
    if (doc.details.kind !== "deal") throw new Error("expected deal");
    expect(doc.details.deal).toMatchObject({
      target: "APL Apollo Foundation (Foundation)",
      relatedParty: true,
      armsLength: true,
      targetTurnoverInr: 23200000,
    });
  });

  it("humanises tag names", () => {
    expect(humanize("NameOfTheTargetEntity")).toBe("Name of the target entity");
  });
});

describe("screener.in company page", () => {
  it("parses cells and row labels", () => {
    expect(parseCell("1,23,456")).toBe(123456);
    expect(parseCell("-64,706")).toBe(-64706);
    expect(parseCell("18%")).toBe(18);
    expect(parseCell("")).toBeNull();
    expect(rowKey("Net Profit +")).toBe("net profit");
    expect(rowKey("CFO/EBITDA       Share of operating profit")).toBe("cfo/ebitda");
  });

  const rel = parseScreenerPage(fixture("screener-reliance-consolidated.html"), "RELIANCE", "consolidated");

  it("reads identity and exchange codes", () => {
    expect(rel.name).toMatch(/Reliance Industries/);
    expect(rel.bseCode).toBe("500325");
    expect(rel.isLender).toBe(false);
    expect(rel.units).toBe("₹ crore");
  });

  it("reads quarterly results with exact period-end keys", () => {
    expect(rel.quarters.periods.at(-1)).toEqual({ key: "2026-06-30", label: "Jun 2026" });
    expect(rel.quarters.rows["sales"].at(-1)).toBe(309468);
    expect(rel.quarters.rows["operating profit"].at(-1)).toBe(47517);
    expect(rel.quarters.rows["net profit"].at(-1)).toBe(23196);
  });

  it("reads annual statements, cash flow and ratios", () => {
    expect(rel.annual.periods.at(-1)?.key).toBe("TTM");
    expect(rel.balanceSheet.rows["borrowings"].at(-1)).toBe(402962);
    expect(rel.cashFlow.rows["cash from operating activity"].at(-1)).toBe(192113);
    expect(rel.ratios.rows["cash conversion cycle"].at(-1)).toBe(25);
  });

  it("collects primary documents", () => {
    expect(rel.annualReports[0]).toMatchObject({ year: 2026 });
    expect(rel.annualReports[0].url).toMatch(/bseindia\.com/);
    const withTranscripts = rel.concalls.filter((c) => c.transcriptUrl);
    expect(withTranscripts.length).toBeGreaterThanOrEqual(4);
    expect(withTranscripts[0]).toMatchObject({ label: "Jul 2026", month: "2026-07" });
    expect(new Set(withTranscripts.map((c) => c.transcriptUrl)).size).toBe(withTranscripts.length);
    expect(rel.announcements[0].title).toMatch(/Jio Platforms/);
    expect(rel.announcements[0].date).toBe("2026-10-27T22:11:23+05:30");
  });

  it("recognises lender formats and empty consolidated pages", () => {
    const hf = parseScreenerPage(fixture("screener-homefirst-standalone.html"), "HOMEFIRST", "standalone");
    expect(hf.isLender).toBe(true);
    expect(hf.quarters.periods.at(-1)?.key).toBe("2026-09-30");
    expect(hf.quarters.rows["revenue"].at(-1)).toBe(567);
    const empty = parseScreenerPage(fixture("screener-homefirst-consolidated-empty.html"), "HOMEFIRST", "consolidated");
    expect(empty.quarters.periods).toHaveLength(0);
  });
});

describe("a screener page that is not a company page", () => {
  it("is refused instead of parsing into a company with empty tables", () => {
    const url = "https://www.screener.in/company/ACME/consolidated/";
    for (const html of ["", "<html><body><h1>Error 500</h1></body></html>", "<html><body>Just a moment… checking your browser</body></html>"]) {
      expect(() => assertCompanyPage(html, url)).toThrow(/not a company page/);
    }
    // Even a company with no consolidated statements has its ratio block.
    expect(assertCompanyPage('<div id="top-ratios"></div>', url)).toBe('<div id="top-ratios"></div>');
  });
});
