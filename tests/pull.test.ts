import { describe, expect, it } from "vitest";
import type { PrimarySource, StatementSet, StatementTable } from "@/lib/data/schema";
import { anchorClaims, coverageLine } from "@/lib/research/pipeline";
import { analyzeFinancials } from "@/lib/research/financials";
import { locateFigure, sameFigure } from "@/lib/research/anchor";
import { businessSnapshot, evidenceOf } from "@/lib/research/business";
import { buildCase } from "@/lib/research/case";
import { discoverDocuments, parseExtras, type ExtraSource } from "@/lib/research/discover";
import { chunkDocument, detectSections, ingestDocument, keepCompanyDocs, LIMITS, namesCompany, type DocRef, type IngestedDoc } from "@/lib/research/ingest";
import { assess, checkClaimedActuals } from "@/lib/research/narrative";
import { buildIndex, search } from "@/lib/research/retrieve";
import { quoteAppears, type Sentence } from "@/lib/research/transcript";
import type { Claim, GuidanceStatement } from "@/lib/research/types";
import type { PdfText } from "@/lib/sources/pdf";

/**
 * Pull research: every test runs on in-memory documents through an injected loader, so nothing
 * here touches the network. The documents are written for the test; no company figures are real.
 */

// ---- helpers -------------------------------------------------------------------------------

const FILLER = "The Board reviewed the operations of the Company during the year under review and noted the performance of each business. ";

/** A read document built the way ingestion builds one, from page text. */
function readDoc(ref: DocRef, pages: string[]): IngestedDoc {
  return { ...ref, status: "read", coverage: { pagesRead: pages.length, totalPages: pages.length, truncated: false }, pages, ...chunkDocument(ref, pages) };
}

function failedDoc(ref: DocRef, error = "Server responded 404"): IngestedDoc {
  return { ...ref, status: "failed", error, coverage: { pagesRead: 0, totalPages: 0, truncated: false }, pages: [], chunks: [] };
}

const loaderOf =
  (pages: string[], totalPages = pages.length, seen?: { maxPages?: number }[]) =>
  async (_url: string, opts: { maxPages?: number } = {}) => {
    seen?.push(opts);
    const value: PdfText = { pages, totalPages, truncated: totalPages > pages.length };
    return { value, fetchedAt: "2026-10-28T04:00:00.000Z", provenance: "live" as const };
  };

const AR_REF: DocRef = { id: "ar-2026", kind: "annual_report", title: "Annual report 2026", url: "https://example.com/ar-2026.pdf", fy: 2026, period: "FY26", date: "2026" };
const CALL_REF: DocRef = { id: "call-2026-08", kind: "transcript", title: "Q1 FY27 call", url: "https://example.com/q1fy27-call.pdf", period: "Q1 FY27", date: "2026-08" };
const RESULTS_REF: DocRef = { id: "results-2026-06-30", kind: "results", title: "Q1 FY27 results", url: "https://example.com/q1fy27-results.pdf", period: "Q1 FY27", periodEnd: "2026-06-30" };

const AR_PAGES = [
  `Corporate Overview\nAcme Instruments is engaged in the business of manufacturing precision sensors and control systems, providing engineering solutions to customers in automotive, industrial and energy markets across India and overseas. ${FILLER}`,
  `Management Discussion and Analysis\nDemand for industrial automation products remained strong through the year, and the Company commissioned a new plant to add capacity for its control systems portfolio. ${FILLER}`,
  `Consolidated Statement of Profit and Loss for the year ended 31 March 2026\n(₹ in lakh)\nRevenue from operations 4,56,789.12 3,95,010.40\nProfit for the year 41,250.75 35,980.00`,
  `Notes to the Consolidated Financial Statements\nSegment information. The Group has identified two reportable segments, namely: Precision Sensors and Control Systems. ${FILLER}`,
];

const CALL_PAGES = [
  "Moderator: Ladies and gentlemen, good day and welcome to the Q1 FY27 earnings conference call of Acme Instruments Limited.",
  "Ravi Menon: Thank you. Revenue for the quarter grew 18% year-on-year, driven by demand from industrial customers and the new plant.\nAnalyst One: Can you talk about the order book and how demand looks for the rest of the year?",
  "Ravi Menon: Our order book stands at a record level and gives us visibility across sensors and control systems.",
];

/** Five quarters ending Jun 2025 … Jun 2026, with statements in ₹ crore. */
function company(rows: Record<string, (number | null)[]>): StatementSet {
  const keys = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
  const table = (r: Record<string, (number | null)[]>, k = keys): StatementTable => ({ periods: k.map((key) => ({ key, label: key })), rows: r, order: Object.keys(r) });
  const empty = table({});
  return { symbol: "ACME", name: "Acme Instruments", basis: "consolidated", isLender: false, units: "₹ crore", quarters: table(rows), annual: empty, balanceSheet: empty, cashFlow: empty, ratios: empty };
}

const QUARTERS = company({ sales: [1000, 1040, 1080, 1120, 1170], "operating profit": [150, 160, 170, 180, 200], "net profit": [100, 104, 108, 112, 120] });

function source(kind: PrimarySource["kind"], date: string, extra: Partial<PrimarySource> = {}): PrimarySource {
  return {
    id: `${kind}-${date}`,
    symbol: "ACME",
    kind,
    title: `${kind} ${date}`,
    url: `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${kind}-${date}.pdf`,
    date,
    host: "BSE",
    discoveredVia: { provider: "screener", type: "aggregator", url: "https://www.screener.in/company/ACME/", retrievedAt: "2026-10-28T04:00:00.000Z", mode: "live" },
    retrieval: { status: "not_fetched" },
    ...extra,
  };
}

const sentence = (text: string, extra: Partial<Sentence> = {}): Sentence => ({ text, page: 2, speaker: "Ravi Menon", isQuestion: false, ...extra });

// ---- source filtering ----------------------------------------------------------------------

describe("source filtering", () => {
  const ar = readDoc(AR_REF, AR_PAGES);
  const call = readDoc(CALL_REF, CALL_PAGES);

  it("only indexes documents FINN actually read", () => {
    const broken: IngestedDoc = { ...readDoc({ ...AR_REF, id: "ar-2025", url: "https://example.com/ar-2025.pdf" }, ["Zirconium widgets are our only business line, sold to customers worldwide."]), status: "failed" };
    const index = buildIndex([ar, call, broken]);
    expect(index.chunks.every((c) => c.docId !== "ar-2025")).toBe(true);
    expect(search(index, "zirconium widgets")).toEqual([]);
  });

  it("sets aside a read document that never names the company, so another company's report is not used", () => {
    const other = readDoc({ ...AR_REF, id: "user-1", title: "Annual report 2026 (added by you)", url: "https://example.com/beta.pdf" }, [
      "Beta Foods Limited is engaged in the business of packaged snacks and beverages for retail customers.",
      "Revenue from operations 4,56,789.12 3,95,010.40",
    ]);
    const kept = keepCompanyDocs([ar, call, other], "Acme Instruments", "ACME");
    expect(kept.map((d) => d.status)).toEqual(["read", "read", "failed"]);
    expect(kept[2]).toMatchObject({ error: expect.stringMatching(/never names Acme Instruments \(ACME\)/), chunks: [], pages: [] });
    // Set aside means unsearchable and unmatchable: its passages and its figures are gone.
    expect(search(buildIndex(kept), "packaged snacks beverages")).toEqual([]);
  });

  it("recognises the company by its name or by its symbol as a whole word", () => {
    expect(namesCompany(["Q1 FY27 earnings call of Acme Instruments Limited"], "Acme Instruments", "ACME")).toBe(true);
    expect(namesCompany(["ACME: results for the quarter"], "Acme Instruments", "ACME")).toBe(true);
    expect(namesCompany(["Larsen & Toubro Limited, annual report"], "Larsen & Toubro", "LT")).toBe(true);
    // A symbol inside another word, or a different company sharing only the first name word, is not a match.
    // (A symbol that is itself a common word, such as TITAN, does match that word: the guard catches
    // accidents, not every lookalike.)
    expect(namesCompany(["Acmetech Systems annual report", "Acme Foods Limited", "ACMEINSTRUMENTS"], "Acme Instruments", "ACMEINST")).toBe(false);
  });

  it("never returns another company's passages: the index holds one company's documents", () => {
    const other = readDoc({ ...AR_REF, id: "other-ar", url: "https://example.com/other.pdf" }, ["Beta Foods is engaged in the business of packaged snacks and beverages for retail customers."]);
    const index = buildIndex([ar, call]);
    expect(search(index, "packaged snacks beverages")).toEqual([]);
    // Built with the other company, the same query finds it — the filter is the index, not luck.
    expect(search(buildIndex([other]), "packaged snacks beverages")[0].chunk.docId).toBe("other-ar");
  });

  it("restricts a search to the requested document kinds and ids", () => {
    const index = buildIndex([ar, call]);
    const calls = search(index, "demand customers plant", { kinds: ["transcript"], limit: 10 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((h) => h.chunk.docId === "call-2026-08")).toBe(true);
    const reports = search(index, "demand customers plant", { docIds: ["ar-2026"], limit: 10 });
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((h) => h.chunk.docId === "ar-2026")).toBe(true);
  });

  it("selects the latest annual report, the last four calls, the latest deck and the results filing — not ratings or other filings", () => {
    const documents = [
      source("annual_report", "2026"),
      source("annual_report", "2025"),
      source("annual_report", "2024"),
      source("annual_report", "2023"),
      ...["2026-08", "2026-05", "2026-02", "2025-11", "2025-08"].map((d) => source("transcript", d)),
      source("presentation", "2026-08"),
      source("presentation", "2026-05"),
      source("credit_rating", "2026-07"),
      source("filing", "2026-09"),
    ];
    const { selected, listed } = discoverDocuments({ documents }, RESULTS_REF);
    expect(selected.map((d) => d.id)).toEqual(["annual_report-2026", "call-2026-08", "call-2026-05", "call-2026-02", "call-2025-11", "ppt-2026-08", "results-2026-06-30"]);
    expect(listed.map((d) => d.id)).toEqual(["annual_report-2025", "annual_report-2024"]);
  });

  it("adds the investor's documents, dropping one that repeats a discovered URL", () => {
    const documents = [source("annual_report", "2026")];
    const extras: ExtraSource[] = [
      { url: documents[0].url, kind: "annual_report", period: "2026" },
      { url: "https://acme.example.com/ir/q2fy27-transcript.pdf", kind: "transcript", period: "2026-11" },
    ];
    const { selected } = discoverDocuments({ documents }, null, extras);
    expect(selected.map((d) => d.id)).toEqual(["annual_report-2026", "call-2026-11-user"]);
    expect(selected[1]).toMatchObject({ userAdded: true, kind: "transcript" });
  });

  it("accepts only public https links of a known kind", () => {
    const raw = JSON.stringify([
      { url: "http://acme.example.com/ar.pdf", kind: "annual_report" },
      { url: "https://localhost/ar.pdf", kind: "annual_report" },
      { url: "https://10.0.0.4/ar.pdf", kind: "annual_report" },
      { url: "https://acme.example.com/note.pdf", kind: "broker_note" },
    ]);
    const { extras, errors } = parseExtras(raw);
    expect(extras).toEqual([]);
    expect(errors).toHaveLength(3); // only the first three items are considered
    expect(errors[0]).toMatch(/public https/);
    expect(parseExtras("[{").errors).toEqual(["Added sources could not be read"]);
    expect(parseExtras(JSON.stringify([{ url: "https://acme.example.com/x.pdf", kind: "broker_note" }])).errors[0]).toMatch(/unknown document type/);
  });
});

// ---- citation preservation -----------------------------------------------------------------

describe("citation preservation", () => {
  it("never drops a short sentence from the middle of a quoted passage", () => {
    const pages = ["Ravi Menon: We now supply one OEM in the U.S. and one in Japan. We have started doing this across all our regions, and it is step one."];
    const { chunks, sentences } = chunkDocument(CALL_REF, pages);
    // "and one in Japan." is too short to score as guidance, but it stays in the passage.
    expect(sentences?.some((s) => s.text === "and one in Japan.")).toBe(false);
    expect(chunks[0].text).toBe("We now supply one OEM in the U.S. and one in Japan. We have started doing this across all our regions, and it is step one.");
    expect(quoteAppears(chunks[0].text, pages[0])).toBe(true);
  });

  it("keeps each transcript passage on its page with its speaker, verbatim", () => {
    const { chunks, sentences } = chunkDocument(CALL_REF, CALL_PAGES);
    const growth = chunks.find((c) => c.text.includes("grew 18%"))!;
    expect(growth).toMatchObject({ page: 2, speaker: "Ravi Menon" });
    const question = chunks.find((c) => c.text.includes("order book and how demand"))!;
    expect(question).toMatchObject({ page: 2, speaker: "Analyst One" });
    expect(chunks.find((c) => c.text.includes("record level"))).toMatchObject({ page: 3, speaker: "Ravi Menon" });
    for (const c of chunks) expect(quoteAppears(c.text, CALL_PAGES[c.page - 1])).toBe(true);
    expect(sentences?.find((s) => s.text.includes("order book and how"))?.isQuestion).toBe(true);
  });

  it("keeps each annual-report passage on its page with the detected section", () => {
    const { chunks } = chunkDocument(AR_REF, AR_PAGES);
    expect(detectSections(AR_PAGES)).toEqual(["Corporate overview", "Management discussion and analysis", "Consolidated financial statements", "Notes to the consolidated financial statements"]);
    for (const c of chunks) {
      expect(quoteAppears(c.text, AR_PAGES[c.page - 1])).toBe(true);
      expect(c.section).toBe(detectSections(AR_PAGES)[c.page - 1]);
    }
    const ev = evidenceOf(chunks[0], 120);
    expect(ev.excerpt.length).toBeLessThanOrEqual(121);
    expect(quoteAppears(ev.excerpt.replace(/…$/, ""), AR_PAGES[ev.page - 1])).toBe(true);
  });

  it("ignores a navigation bar repeated on every page when detecting sections", () => {
    const nav = "Corporate Overview Statutory Reports Financial Statements";
    const pages = [
      `Message from the Chairperson\nDear shareholders, this was a year of building capacity. ${FILLER}`,
      `${nav}\nBusiness Responsibility and Sustainability Report\nSection A: general disclosures. ${FILLER}`,
      `${nav}\nPrinciple 2: products and services that are safe. ${FILLER}`,
      `${nav}\nIndependent Auditor's Report\nTo the members. ${FILLER}`,
      `${nav}\nKey audit matters. ${FILLER}`,
      `${nav}\nNotes to the Consolidated Financial Statements\nSegment information. ${FILLER}`,
    ];
    expect(detectSections(pages)).toEqual([
      "Leadership message",
      "Business responsibility report",
      "Business responsibility report",
      "Independent auditor's report",
      "Independent auditor's report",
      "Notes to the consolidated financial statements",
    ]);
  });

  it("cites a located figure to its page with a verbatim excerpt, and says so when it is document-level", () => {
    const docs = [readDoc(AR_REF, AR_PAGES), readDoc(RESULTS_REF, ["Statement of unaudited consolidated financial results for the quarter ended 30 June 2026\n(₹ crore)\nRevenue from operations 1,170.40 1,120.10 1,000.20"])];
    const screener = [{ sourceId: "screener", section: "profit-loss" }];
    const claims: Claim[] = [
      { id: "traj-revenue-cagr", text: "Revenue grew.", tone: "positive", citations: screener, figures: [{ metric: "revenue", fy: 2026, value: 4568 }, { metric: "revenue", fy: 2025, value: 3950 }] },
      { id: "traj-pat-cagr", text: "PAT grew.", tone: "positive", citations: screener, figures: [{ metric: "pat", fy: 2026, value: 999 }] },
      { id: "traj-old", text: "Older figure.", tone: "neutral", citations: screener, figures: [{ metric: "revenue", fy: 2023, value: 3000 }] },
      { id: "head-latest-quarter", text: "Q1 revenue.", tone: "neutral", citations: [{ sourceId: "screener", section: "quarters" }], figures: [{ metric: "revenue", fy: 2027, quarter: "2026-06-30", value: 1170 }] },
      { id: "bs-de", text: "No figures.", tone: "neutral", citations: [{ sourceId: "screener", section: "balance-sheet" }] },
    ];
    const [rev, pat, old, quarter, bs] = anchorClaims(claims, docs, "consolidated");

    // Both years sit on one page of the FY26 report (FY25 is its comparative column): one citation.
    const page = rev.citations.filter((c) => c.level === "page");
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ sourceId: "ar-2026", page: 3, section: "Consolidated financial statements", unit: "₹ lakh" });
    expect(quoteAppears(page[0].excerpt!, AR_PAGES[2])).toBe(true);
    // The standardised table stays, marked as a table-level (secondary) citation.
    expect(rev.citations.at(-1)).toEqual({ sourceId: "screener", section: "profit-loss", level: "section" });

    // Not on any page: a document-level citation that says so, never an invented page.
    expect(pat.citations[0]).toEqual({ sourceId: "ar-2026", level: "document", section: "PAT FY26 not located on a page" });
    expect(pat.citations[0].page).toBeUndefined();

    // FY23 is not covered by the FY26 report: no primary citation at all.
    expect(old.citations.map((c) => c.sourceId)).toEqual(["screener"]);

    expect(quarter.citations[0]).toMatchObject({ sourceId: "results-2026-06-30", page: 1, level: "page" });
    expect(bs.citations).toEqual([{ sourceId: "screener", section: "balance-sheet", level: "section" }]);
  });

  it("never cites a document that could not be read", () => {
    const claims: Claim[] = [{ id: "traj-revenue-cagr", text: "Revenue grew.", tone: "positive", citations: [], figures: [{ metric: "revenue", fy: 2026, value: 4568 }] }];
    const [c] = anchorClaims(claims, [failedDoc(AR_REF)], "consolidated");
    expect(c.citations).toEqual([]);
  });
});

// ---- missing sources -----------------------------------------------------------------------

describe("missing sources", () => {
  it("reports a failed link as failed, with the reason, instead of throwing", async () => {
    const doc = await ingestDocument(AR_REF, async () => {
      throw new Error("Server responded 404 for https://example.com/ar-2026.pdf");
    });
    expect(doc).toMatchObject({ status: "failed", chunks: [], pages: [] });
    expect(doc.error).toMatch(/404/);
  });

  it("marks a scanned PDF as scanned and extracts nothing from it", async () => {
    const doc = await ingestDocument(AR_REF, loaderOf(["", " ", "12"]));
    expect(doc.status).toBe("scanned");
    expect(doc.error).toMatch(/does not OCR/);
    expect(doc.chunks).toEqual([]);
  });

  it("reads long annual reports up to the limit and records the coverage", async () => {
    const seen: { maxPages?: number }[] = [];
    const doc = await ingestDocument(AR_REF, loaderOf(AR_PAGES, 412, seen));
    expect(seen[0].maxPages).toBe(LIMITS.annual_report.maxPages);
    expect(doc.status).toBe("read");
    expect(doc.coverage).toEqual({ pagesRead: 4, totalPages: 412, truncated: true });
  });

  it("states what is missing in the business snapshot and routes to adding a source", () => {
    const call = readDoc(CALL_REF, CALL_PAGES);
    const none = businessSnapshot([call], buildIndex([call]));
    expect(none.status).toBe("no_annual_report");
    expect(none.note).toMatch(/Add one under Sources/);
    expect(none.overview).toEqual([]);

    const broken = [failedDoc(AR_REF, "Server responded 404"), call];
    const unreadable = businessSnapshot(broken, buildIndex(broken));
    expect(unreadable.status).toBe("unreadable");
    expect(unreadable.note).toMatch(/404/);

    expect(businessSnapshot([call], buildIndex([call]), { demo: true }).status).toBe("skipped");
  });

  it("quotes the annual report and its segment note when one was read", () => {
    const docs = [readDoc(AR_REF, AR_PAGES), readDoc(CALL_REF, CALL_PAGES)];
    const b = businessSnapshot(docs, buildIndex(docs));
    expect(b.status).toBe("ok");
    expect(b.overview.length).toBeGreaterThan(0);
    for (const e of b.overview) expect(quoteAppears(e.excerpt.replace(/…$/, ""), AR_PAGES[e.page - 1])).toBe(true);
    expect(b.segments).toMatchObject({ single: false, names: ["Precision Sensors", "Control Systems"], evidence: { page: 4 } });
    // Management's framing comes from the call, never from a question or the moderator.
    expect(b.management.every((e) => e.speaker === "Ravi Menon")).toBe(true);
  });

  it("quotes a single-segment statement whole, even when it opens the passage", () => {
    const pages = [`Notes to the Consolidated Financial Statements\nThe Company operates predominantly in one business segment of precision sensors and accordingly segment disclosures are not applicable. ${FILLER}`];
    const docs = [readDoc(AR_REF, pages)];
    const b = businessSnapshot(docs, buildIndex(docs));
    expect(b.segments).toMatchObject({ single: true, names: [], evidence: { page: 1, section: "Notes to the consolidated financial statements" } });
    const excerpt = b.segments!.evidence.excerpt;
    // The excerpt opens at most ~80 characters before the match, marked "…" when it is cut there.
    expect(excerpt).toMatch(/^…[^…]*The Company operates predominantly in one business segment/);
    expect(excerpt.endsWith("segment disclosures are not applicable.")).toBe(true);
    expect(quoteAppears(excerpt.slice(1), pages[0])).toBe(true);
  });

  it("does not read segment names out of marketing prose", () => {
    const pages = [
      `Board's Report\nThis was later scaled through cohort-led communication across nine business segments, resulting in 45 distinct communication sets being rolled out across formats, and backed by sales toolkits for branches. ${FILLER}`,
      `Corporate Overview\nOur business segments are growing fast, and customers, partners and employees all benefit from it. ${FILLER}`,
    ];
    const docs = [readDoc(AR_REF, pages)];
    const b = businessSnapshot(docs, buildIndex(docs));
    expect(b.status).toBe("ok");
    expect(b.segments).toBeNull();
  });

  it("does not read segments out of an accounting note that mentions them, and keeps '&' inside a name", () => {
    const goodwill = `Notes to the Consolidated Financial Statements\nIn case the acquired business is spread across multiple operating segments, goodwill is allocated so that impairment testing does not cross an operating segment (ii) Brand, Customer Relationships and other rights are amortised over their useful lives. ${FILLER}`;
    const docsA = [readDoc(AR_REF, [goodwill])];
    expect(businessSnapshot(docsA, buildIndex(docsA)).segments).toBeNull();

    const note = `Notes to the Consolidated Financial Statements\nSegment information. The Group's reportable segments are Consumer & Bazaar (C&B) and Business to Business (B2B), as reviewed by the chief operating decision maker. ${FILLER}`;
    const docsB = [readDoc(AR_REF, [note])];
    expect(businessSnapshot(docsB, buildIndex(docsB)).segments?.names).toEqual(["Consumer & Bazaar (C&B)", "Business to Business (B2B)"]);
  });

  it("prefers the passage that says what the company is over a biography or a BRSR form", () => {
    const pages = [
      `Board of Directors\nMr. A. Rao joined Acme Instruments in 1992 in the supply chain division of the Company, where he was in charge of customers, products, services and markets. ${FILLER}`,
      `Business Responsibility & Sustainability Report\nDetails of business activities of the entity: the entity manufactures products and services for customers in markets across India. ${FILLER}`,
      `Corporate Overview\nWe are Acme Instruments, India's leading maker of precision sensors for industrial customers. ${FILLER}`,
    ];
    const docs = [readDoc(AR_REF, pages)];
    const b = businessSnapshot(docs, buildIndex(docs), { company: "Acme Instruments" });
    expect(b.overview[0].page).toBe(3);
    expect(detectSections(pages)[1]).toBe("Business responsibility report");
  });

  it("opens a self-description at the company's name when a page heading runs into it", () => {
    const pages = [`Corporate Overview\nShaping the Future of Sensing About Acme Instruments Acme Instruments Limited ('Acme' or 'We') is a leading maker of precision sensors for industrial customers. ${FILLER}`];
    const docs = [readDoc(AR_REF, pages)];
    const b = businessSnapshot(docs, buildIndex(docs), { company: "Acme Instruments" });
    const excerpt = b.overview[0].excerpt;
    expect(excerpt.startsWith("Acme Instruments Limited ('Acme' or 'We') is a leading maker")).toBe(true);
    expect(quoteAppears(excerpt.replace(/…$/, ""), pages[0])).toBe(true);
  });

  it("finds nothing to select when a company lists no documents", () => {
    expect(discoverDocuments({ documents: [] }, null)).toEqual({ selected: [], listed: [] });
  });

  it("summarises coverage, counting what could not be read", () => {
    const docs = [
      { ...readDoc(AR_REF, AR_PAGES), coverage: { pagesRead: 300, totalPages: 412, truncated: true } },
      readDoc(CALL_REF, CALL_PAGES),
      readDoc({ ...CALL_REF, id: "call-2026-05", url: "https://example.com/q4.pdf" }, CALL_PAGES),
      readDoc(RESULTS_REF, ["Revenue from operations 1,170.40"]),
      failedDoc({ ...CALL_REF, id: "call-2026-02", url: "https://example.com/q3.pdf" }),
    ];
    expect(coverageLine(docs, "live")).toBe("Read the FY26 annual report (300 of 412 pages), 2 call transcripts and the Q1 FY27 results filing; 1 document could not be read (see Sources).");
    expect(coverageLine([failedDoc(AR_REF)], "live")).toBe("Read no primary documents; 1 document could not be read (see Sources).");
    expect(coverageLine([], "demo")).toMatch(/^Demo mode reads no documents/);
  });
});

// ---- period alignment ----------------------------------------------------------------------

describe("period alignment", () => {
  it("labels an annual report by the fiscal year it reports, and a call by the quarter it discusses", () => {
    const { selected } = discoverDocuments({ documents: [source("annual_report", "2026"), source("transcript", "2026-08", { period: "Q1 FY27" })] }, null, [
      { url: "https://acme.example.com/ar-2025.pdf", kind: "annual_report", period: "2025" },
      { url: "https://acme.example.com/call-feb.pdf", kind: "transcript", period: "2026-02" },
    ]);
    expect(selected.find((d) => d.id === "annual_report-2026")).toMatchObject({ fy: 2026, period: "FY26" });
    expect(selected.find((d) => d.id === "user-1")).toMatchObject({ fy: 2025, period: "FY25", kind: "annual_report" });
    // A call held in February discusses the December quarter: Q3 FY26.
    expect(selected.find((d) => d.id === "call-2026-02-user")).toMatchObject({ period: "Q3 FY26" });
  });

  it("rejects added sources whose period cannot be aligned", () => {
    const { extras, errors } = parseExtras(
      JSON.stringify([
        { url: "https://acme.example.com/ar.pdf", kind: "annual_report", period: "FY26" },
        { url: "https://acme.example.com/call.pdf", kind: "transcript", period: "2026-13" },
        { url: "https://acme.example.com/deck.pdf", kind: "presentation" },
      ]),
    );
    expect(errors).toEqual(["Skipped https://acme.example.com/ar.pdf: an annual report's year looks like 2026", "Skipped https://acme.example.com/call.pdf: a call's month looks like 2026-08"]);
    expect(extras).toEqual([{ url: "https://acme.example.com/deck.pdf", kind: "presentation" }]);
  });

  it("matches a quarterly figure only to the results filing that reports that quarter", () => {
    const results = readDoc(RESULTS_REF, ["Unaudited consolidated results\nRevenue from operations 1,170.40 1,120.10 1,000.20"]);
    const claim = (quarter: string, value: number): Claim => ({ id: "head-latest-quarter", text: "Quarter.", tone: "neutral", citations: [], figures: [{ metric: "revenue", fy: 2027, quarter, value }] });
    // The filing for the June 2026 quarter carries that quarter, the previous one and the year-ago one.
    expect(anchorClaims([claim("2026-06-30", 1170)], [results], "consolidated")[0].citations[0]).toMatchObject({ page: 1, level: "page" });
    expect(anchorClaims([claim("2026-03-31", 1120)], [results], "consolidated")[0].citations[0]).toMatchObject({ page: 1, level: "page" });
    expect(anchorClaims([claim("2025-06-30", 1000)], [results], "consolidated")[0].citations[0]).toMatchObject({ page: 1, level: "page" });
    // December 2025 is not in it, even if the same number appears: no citation.
    expect(anchorClaims([claim("2025-12-31", 1170)], [results], "consolidated")[0].citations).toEqual([]);
    // A full-year figure is never traced to a quarterly filing.
    const annual: Claim = { id: "traj-revenue-cagr", text: "Year.", tone: "neutral", citations: [], figures: [{ metric: "revenue", fy: 2026, value: 1170 }] };
    expect(anchorClaims([annual], [results], "consolidated")[0].citations).toEqual([]);
  });

  it("checks a number said on a call against the quarter that call discusses", () => {
    const [check] = checkClaimedActuals([{ sourceId: "call-2026-08", callMonth: "2026-08", sentences: [sentence("Revenue for the quarter grew 18% year-on-year, driven by industrial demand.")] }], QUARTERS);
    expect(check).toMatchObject({ quarter: "Q1 FY27", metric: "revenue_growth", claimed: 18, reported: 17, status: "consistent", page: 2, speaker: "Ravi Menon" });
  });
});

// ---- deterministic metrics -----------------------------------------------------------------

describe("deterministic metrics", () => {
  it("recognises a ₹-crore figure stated in crore, lakh or million, within rounding", () => {
    expect(sameFigure(4567.89, 4568)).toBe("₹ crore");
    expect(sameFigure(456789.12, 4568)).toBe("₹ lakh");
    expect(sameFigure(45678.9, 4568)).toBe("₹ million");
    expect(sameFigure(4600, 4568)).toBeNull();
  });

  it("locates a figure on the page that labels it, preferring the consolidated statement", () => {
    const pages = [
      "Standalone Statement of Profit and Loss\nRevenue from operations 4,567.89",
      "Directors' report\nThe Company's turnover is discussed below. 4,567.89",
      "Consolidated Statement of Profit and Loss\nRevenue from operations\n(Note 25)\n4,567.89",
    ];
    expect(locateFigure(pages, { metric: "revenue", value: 4568 }, { basis: "consolidated" })).toEqual({ page: 3, excerpt: "Revenue from operations … 4,567.89", unit: "₹ crore" });
    expect(locateFigure(pages, { metric: "revenue", value: 4568 }, { basis: "standalone" })).toMatchObject({ page: 1 });
    // A number without its label on the line, a different number, or a tiny value: no citation.
    expect(locateFigure([pages[1]], { metric: "revenue", value: 4568 })).toBeNull();
    expect(locateFigure(pages, { metric: "revenue", value: 5000 })).toBeNull();
    expect(locateFigure(["Revenue from operations 4.20"], { metric: "revenue", value: 4.2 })).toBeNull();
    expect(locateFigure([AR_PAGES[2]], { metric: "pat", value: 412.5 })).toMatchObject({ page: 1, unit: "₹ lakh" });
  });

  it("reads labels in OCR'd filings with merged or garbled words", () => {
    expect(locateFigure(["la) Revenue froim operations 9,460.17 1242638 6,734.66"], { metric: "revenue", value: 946 })).toMatchObject({ page: 1, unit: "₹ million" });
    expect(locateFigure(["7 |Profitfor the period/ year (5-6) 564.26 912.23"], { metric: "pat", value: 56.4 })).toMatchObject({ unit: "₹ million" });
    // Two whole words between "revenue" and "operations" is a different line item.
    expect(locateFigure(["Revenue from discontinued operations 9,460.17"], { metric: "revenue", value: 946 })).toBeNull();
  });

  it("assesses promises by the stated thresholds", () => {
    const target = (actual: number, status: "missed" | "delivered" | "on_track" = "missed") =>
      assess({ metric: "revenue_target", low: 4000, high: 4000, unit: "INR_cr", verdict: { status, actual, basis: "test" } }).assessment;
    expect(target(4100, "delivered")).toBe("met");
    expect(target(3700)).toBe("partially met"); // 92.5% of the target
    expect(target(3500)).toBe("missed"); // 87.5%
    expect(target(2000, "on_track")).toBe("not comparable / insufficient evidence");

    const growth = (actual: number) => assess({ metric: "revenue_growth", low: 20, high: 25, unit: "%", verdict: { status: "missed", actual, basis: "test" } });
    expect(growth(18.5)).toMatchObject({ assessment: "partially met", note: "18.5% reported — 1.5 percentage points short of 20–25%" });
    expect(growth(17).assessment).toBe("missed");

    const margin = (actual: number) => assess({ metric: "ebitda_margin", low: 20, high: 20, unit: "%", verdict: { status: "missed", actual, basis: "test" } }).assessment;
    expect(margin(19.2)).toBe("partially met");
    expect(margin(18.5)).toBe("missed");
    expect(assess({ metric: undefined, verdict: undefined }).assessment).toBe("not comparable / insufficient evidence");
  });

  it("flags a stated number that conflicts with the reported one, and ignores forward-looking or questioning sentences", () => {
    const checks = checkClaimedActuals(
      [
        {
          sourceId: "call-2026-08",
          callMonth: "2026-08",
          sentences: [
            sentence("PAT for the quarter was up 26% year-on-year on better mix."),
            sentence("EBITDA margin for the quarter stood at 17.5%, helped by operating leverage."),
            sentence("We expect revenue to grow 25% year-on-year this quarter as the plant ramps up."),
            sentence("Did revenue for the quarter grow 30% year-on-year?", { isQuestion: true, speaker: "Analyst One" }),
            sentence("For the full year, revenue grew 30% year-on-year in the quarter just ended."),
          ],
        },
      ],
      QUARTERS,
    );
    expect(checks.map((c) => [c.metric, c.status])).toEqual([
      ["pat_growth", "conflict"], // 26% said vs 20% reported, beyond the 2-point tolerance
      ["ebitda_margin", "consistent"], // 17.5% said vs 17.1% reported
    ]);
    expect(checks[0].note).toMatch(/6\.0-point gap/);
  });

  it("derives capex from operating and free cash flow, and attaches the figures each claim rests on", () => {
    const years = ["2022-03-31", "2023-03-31", "2024-03-31", "2025-03-31", "2026-03-31"];
    const table = (rows: Record<string, number[]>): StatementTable => ({ periods: years.map((key) => ({ key, label: key })), rows, order: Object.keys(rows) });
    const c: StatementSet = {
      ...company({}),
      annual: table({ sales: [800, 900, 1000, 1100, 1300], "operating profit": [120, 135, 150, 170, 210], "net profit": [80, 90, 100, 110, 130] }),
      cashFlow: table({ "cash from operating activity": [100, 120, 150, 130, 200], "free cash flow": [40, 50, 60, 30, 90] }),
    };
    const f = analyzeFinancials(c);
    expect(f.cash.capex).toEqual([60, 70, 90, 100, 110]);
    const capex = f.cash.claims.find((x) => x.id === "cash-capex")!;
    expect(capex.text).toContain("61% of operating cash flow");
    expect(capex.text).toContain("derived as operating cash flow − free cash flow");
    expect(f.cash.claims.find((x) => x.id === "cash-conversion")?.figures).toEqual([
      { metric: "cfo", fy: 2026, value: 200 },
      { metric: "cfo", fy: 2025, value: 130 },
    ]);
    // Same input, same output: no model, no randomness.
    expect(analyzeFinancials(c)).toEqual(f);
  });

  it("builds bull and bear points from cited facts, each with the strongest fact against it", () => {
    const cite = [{ sourceId: "screener", section: "profit-loss", level: "section" as const }];
    const met: GuidanceStatement = {
      id: "s1",
      sourceId: "call-2026-05",
      callLabel: "Q4 FY26 call",
      callMonth: "2026-05",
      page: 4,
      quote: "We will close FY26 with revenue of about 4,000 crore.",
      metric: "revenue_target",
      low: 4000,
      high: 4000,
      unit: "INR_cr",
      period: { label: "FY26", fy: 2026, scope: "FY" },
      assessment: "met",
      assessmentNote: "₹4,100 cr reported against ₹4,000 cr promised",
    } as GuidanceStatement;
    const result = buildCase({
      claims: [
        { id: "traj-revenue-cagr", text: "Revenue compounded 12% a year.", tone: "positive", citations: cite },
        { id: "traj-latest-growth", text: "Revenue growth slowed to 4% in FY26.", tone: "negative", citations: cite },
        { id: "bs-de", text: "Debt to equity rose to 1.4.", tone: "negative", citations: cite },
      ],
      statements: [met],
      checks: [],
    });
    expect(result.bull.map((p) => p.theme)).toEqual(["growth", "credibility"]);
    expect(result.bull[0].counter?.text).toBe("Revenue growth slowed to 4% in FY26.");
    expect(result.bull[1].citations[0]).toMatchObject({ sourceId: "call-2026-05", page: 4, level: "page" });
    expect(result.bear.find((p) => p.theme === "balance sheet")?.counter).toBeNull();
    expect([...result.bull, ...result.bear].every((p) => p.citations.length > 0)).toBe(true);
    expect(result.note).toMatch(/not a recommendation to buy or sell/);
  });
});
