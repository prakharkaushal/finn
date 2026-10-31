import type { Chunk, IngestedDoc } from "@/lib/research/ingest";
import { search, type SearchIndex } from "@/lib/research/retrieve";
import type { BusinessSection, Evidence } from "@/lib/research/types";

/**
 * The business snapshot is the company's own words, not a summary: descriptive passages from
 * the latest annual report, the sentence that names its reporting segments, and management's
 * framing on the latest call. Every item is a verbatim passage with its page. Segment revenue
 * mix is not computed — annual-report segment tables do not survive PDF text extraction
 * reliably enough to do arithmetic on.
 */

const OVERVIEW_QUERY = "company business engaged manufacture manufacturing products services solutions customers clients markets operations portfolio leading provider brands plants presence";
/** How likely a detected section is to describe the business, rather than comply, govern or account. */
const SECTION_WEIGHT: Record<string, number> = {
  "Corporate overview": 1.6,
  "Management discussion and analysis": 1.4,
  "Leadership message": 1.3,
  "Board's report": 1.1,
  "Business responsibility report": 0.35,
  "Corporate governance report": 0.3,
  "Independent auditor's report": 0.1,
  "Notes to the consolidated financial statements": 0.4,
  "Notes to the financial statements": 0.4,
  "Consolidated financial statements": 0.2,
  "Standalone financial statements": 0.2,
};
/** Sentences that say what the company is: "X is a leading…", "engaged in the business of…". */
const DESCRIBES =
  /\b(?:is|are)\s+(?:engaged|a leading|one of|an?\s+(?:integrated|end-to-end|leading|global|diversified))|\bengaged in (?:the )?(?:business|manufactur\w*|provi\w*|design\w*|develop\w*|production|trading|distribution)\b|\bprovider of\b|\bwe are an?\b|\bheadquartered\b|\b(?:india|asia|world)(?:'|’)s\s+(?:leading|largest)\b/i;
/** Director biographies and BRSR forms mention the company and its products without describing it. */
const NOT_A_DESCRIPTION = /\b(?:Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+[A-Z]|\b(?:he|she)\s+(?:was|is|has|joined|holds)\b|\bthe entity\b|\bBRSR\b/;
const MANAGEMENT_QUERY = "business demand customers products segments performance strategy growth order book capacity";

const digitShare = (text: string) => (text.match(/\d/g)?.length ?? 0) / Math.max(1, text.length);

/** A passage, cut at a sentence boundary so the excerpt reads as the document wrote it. */
export function evidenceOf(c: Chunk, max = 420): Evidence {
  let excerpt = c.text;
  if (excerpt.length > max) {
    const cut = excerpt.slice(0, max);
    const end = cut.lastIndexOf(". ");
    excerpt = end > 120 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return { sourceId: c.docId, page: c.page, excerpt, ...(c.section ? { section: c.section } : {}), ...(c.speaker ? { speaker: c.speaker } : {}) };
}

const SEGMENT_SINGLE = /\b(?:only\s+)?(?:one|single)\s+(?:reportable|operating|business|primary)\s+segment\b/i;
const SEGMENT_LIST = /\b(?:reportable|operating|business|primary)\s+segments?\b[^.()]{0,40}?\b(?:are|namely|viz\.?|comprise|comprising|as follows)\s*:?\s*([^.]{3,240})/i;
const SEGMENT_COUNT = /\b(?:two|three|four|five|six|seven|[2-9])\s+(?:reportable|operating|business|primary)\s+segments?\b[^.:]{0,40}?[:,–-]\s*([^.]{3,240})/i;
/** A segment list counts only inside a segment disclosure, not in a note that merely mentions segments. */
const DISCLOSURE = /segment\s+(?:revenue|results?|assets|liabilit\w*|information|reporting)|reportable\s+segments?|ind\s*as\s*108|chief operating decision maker|\bcodm\b/i;
const NOT_A_NAME = /^(?:the|which|this|these|its|company|group|segment|segments|operations|business|based on|identified|accordingly)$/i;

/** The sentence around a match, at most ~80 characters before it (marked … when cut). */
function sentenceAround(text: string, at: number): string {
  const dot = text.lastIndexOf(". ", at);
  let start = dot < 0 ? 0 : dot + 2;
  let lead = "";
  if (at - start > 80) {
    start = text.indexOf(" ", at - 80) + 1;
    lead = "…";
  }
  const endDot = text.indexOf(". ", at);
  return lead + text.slice(start, endDot < 0 ? Math.min(text.length, at + 300) : endDot + 1).trim();
}

export function segmentNames(list: string): string[] {
  return list
    .replace(/\(\s*(?:[ivx]+|[a-h]|\d+)\s*\)|(?:^|[\s,;])(?:[ivx]+|[a-h])\)\s*/gi, ",")
    // "&" stays inside a name: "Consumer & Bazaar (C&B)".
    .split(/,|;|\band\b/i)
    .map((s) => s.replace(/^\s*(?:the|a|an)\s+/i, "").replace(/\s+segment$/i, "").replace(/["“”']/g, "").trim())
    // Segment names are proper nouns in a disclosure ("Treasury", "Retail Banking"); prose is not a name.
    .filter((s) => s.length >= 3 && s.length <= 60 && /^[A-Z]/.test(s) && s.split(/\s+/).length <= 6 && !NOT_A_NAME.test(s))
    .slice(0, 8);
}

/** Consolidated notes first: the group's segments, not the parent's alone. */
const notesRank = (c: Chunk) => (/notes.*consolidated/i.test(c.section ?? "") ? 0 : /notes/i.test(c.section ?? "") ? 1 : 2);

/** The first passage (notes first) that names the reporting segments. */
export function findSegments(docs: IngestedDoc[]): BusinessSection["segments"] {
  const chunks = docs
    .filter((d) => d.status === "read" && (d.kind === "annual_report" || d.kind === "user"))
    .flatMap((d) => d.chunks)
    .sort((a, b) => notesRank(a) - notesRank(b));
  for (const c of chunks) {
    const single = c.text.match(SEGMENT_SINGLE);
    if (single?.index != null) {
      return { names: [], single: true, evidence: { ...evidenceOf(c), excerpt: sentenceAround(c.text, single.index) } };
    }
    const listed = c.text.match(SEGMENT_LIST) ?? c.text.match(SEGMENT_COUNT);
    // "Business segments" in narrative prose is marketing; only a disclosure names reportable segments.
    const disclosure = listed && DISCLOSURE.test(c.text);
    if (listed?.index != null && disclosure) {
      const names = segmentNames(listed[1]);
      if (names.length >= 2) return { names, single: false, evidence: { ...evidenceOf(c), excerpt: sentenceAround(c.text, listed.index) } };
    }
  }
  return null;
}

/** Passages about a subsidiary describe that subsidiary, not the company. */
const SUBSIDIARY = /\bsubsidiar(?:y|ies)\b/i;

export function businessSnapshot(docs: IngestedDoc[], index: SearchIndex, opts: { demo?: boolean; company?: string } = {}): BusinessSection {
  const reports = docs.filter((d) => d.kind === "annual_report" || d.kind === "user");
  const readReports = reports.filter((d) => d.status === "read");
  const transcripts = docs.filter((d) => d.kind === "transcript" && d.status === "read").sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const latestCall = transcripts[0];
  const management = latestCall
    ? search(index, MANAGEMENT_QUERY, {
        docIds: [latestCall.id],
        limit: 2,
        boost: (c) => (c.text.trim().endsWith("?") || /moderator|analyst|participant/i.test(c.speaker ?? "") ? 0 : 1) * (c.page <= 5 ? 1.5 : 1),
      }).map((h) => evidenceOf(h.chunk))
    : [];

  if (opts.demo) {
    return { status: "skipped", overview: [], segments: null, management, note: "Demo mode reads no documents; run in live mode to read the annual report." };
  }
  if (!reports.length) {
    return { status: "no_annual_report", overview: [], segments: null, management, note: "No annual report was found for this company. Add one under Sources to read it." };
  }
  if (!readReports.length) {
    return {
      status: "unreadable",
      overview: [],
      segments: null,
      management,
      note: `The annual report could not be read (${reports[0] && "error" in reports[0] ? reports[0].error : "unreadable"}). Add another copy under Sources.`,
    };
  }
  const seenPages = new Set<string>();
  const pagesOf = new Map(readReports.map((d) => [d.id, d.pages.length]));
  // "Kaynes Technology India" → "kaynes technology": how the company names itself in its own report.
  const nameKey = (opts.company ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
  const sectionWeight = (c: Chunk) => {
    // Undetected sections near the front are the designed narrative pages; later ones are usually statements.
    const front = c.page <= Math.max(20, (pagesOf.get(c.docId) ?? 0) * 0.25);
    return c.section ? (SECTION_WEIGHT[c.section] ?? 1) : front ? 1.2 : 0.6;
  };
  const weight = (c: Chunk) => {
    const self = nameKey && c.text.toLowerCase().includes(nameKey) ? 1.4 : 1;
    return sectionWeight(c) * self * (SUBSIDIARY.test(c.text) ? 0.6 : 1) * (NOT_A_DESCRIPTION.test(c.text) ? 0.3 : 1) * (digitShare(c.text) > 0.12 ? 0.25 : 1) * (c.text.length < 200 ? 0.5 : 1);
  };
  /**
   * Strength 2: the sentence names the company ("Kaynes … is a leading…", "We are Asian Paints");
   * 1: "the Company" or "We" is the subject; 0: not a self-description. `at` is where the sentence starts.
   */
  const describes = (c: Chunk): { strength: number; at: number } => {
    const none = { strength: 0, at: 0 };
    if (sectionWeight(c) < 1 || NOT_A_DESCRIPTION.test(c.text) || SUBSIDIARY.test(c.text)) return none;
    const named = nameKey ? c.text.toLowerCase().indexOf(`we are ${nameKey}`) : -1;
    if (named >= 0) return { strength: 2, at: named };
    const m = c.text.match(DESCRIBES);
    if (m?.index == null) return none;
    const dot = c.text.lastIndexOf(". ", m.index);
    const at = dot < 0 || m.index - dot > 240 ? 0 : dot + 2;
    const sentence = sentenceAround(c.text, m.index).toLowerCase();
    if (/\bnot\s+(?:engaged|a leading|one of)\b/.test(sentence)) return none;
    if (nameKey && sentence.includes(nameKey)) {
      // No sentence boundary before it ("…Integrated ESDM About Kaynes Technology Kaynes Technology
      // India Limited is a leading…": a page heading runs into the text): open at the company's name.
      const nameAt = at === 0 ? c.text.toLowerCase().lastIndexOf(nameKey, m.index) : -1;
      return { strength: 2, at: nameAt > 0 ? nameAt : at };
    }
    return { strength: /\b(?:the company|our company|we|the group)\b/.test(sentence) ? 1 : 0, at };
  };
  // Self-description is a sentence pattern, not a topic, so it is found by pattern across the
  // report (earlier pages first among equals); keyword search only fills the remaining slots.
  const describing = readReports
    .flatMap((d) => d.chunks)
    .map((chunk) => ({ chunk, ...describes(chunk), score: weight(chunk) }))
    .filter((h) => h.strength > 0)
    // The excerpt opens at the describing sentence: a verbatim substring of the passage.
    .map((h) => ({ ...h, chunk: h.at > 0 ? { ...h.chunk, text: h.chunk.text.slice(h.at) } : h.chunk }))
    .sort((a, b) => b.strength - a.strength || b.score - a.score || a.chunk.page - b.chunk.page);
  const lexical = search(index, OVERVIEW_QUERY, { docIds: readReports.map((d) => d.id), limit: 30, boost: weight });
  const overview = [...describing, ...lexical]
    .filter((h) => {
      const key = `${h.chunk.docId}:${h.chunk.page}`;
      if (seenPages.has(key)) return false;
      seenPages.add(key);
      return true;
    })
    .slice(0, 3)
    .map((h) => evidenceOf(h.chunk));
  return {
    status: "ok",
    overview,
    segments: findSegments(readReports),
    management,
    ...(overview.length ? {} : { note: "The annual report was read, but no descriptive passage stood out." }),
  };
}
