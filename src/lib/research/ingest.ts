import { hasTextLayer, loadPdfText } from "@/lib/sources/pdf";
import { recurringLines, transcriptSentences, type Sentence } from "@/lib/research/transcript";

/**
 * Document ingestion for Pull research: fetch a primary document, extract its text page by
 * page, and cut it into passages that remember where they came from — page, detected section,
 * transcript speaker — so every passage FINN shows can be cited back to a page. Extracted text
 * is cached forever per URL (documents never change once filed). Scanned PDFs and failed links
 * come back with a status and a reason, never as an exception.
 */

export type DocKind = "annual_report" | "transcript" | "presentation" | "results" | "user";
export type DocRef = {
  id: string;
  kind: DocKind;
  title: string;
  url: string;
  /** Fiscal period covered: "FY26", "Q1 FY27". */
  period?: string;
  /** Publication month or date: "2026-08", "2026-10-27". */
  date?: string;
  /** Annual reports: the fiscal year they report (FY26 = 2026). */
  fy?: number;
  /** Results filings: the quarter-end they report. */
  periodEnd?: string;
  /** Added by the investor rather than discovered. */
  userAdded?: boolean;
};
export type Chunk = { id: string; docId: string; page: number; text: string; section?: string; speaker?: string };

export type IngestedDoc = DocRef & {
  status: "read" | "scanned" | "failed";
  error?: string;
  coverage: { pagesRead: number; totalPages: number; truncated: boolean };
  /** Page text, 1-based by index + 1. Kept server-side for figure location and quote checks. */
  pages: string[];
  chunks: Chunk[];
  /** Transcripts: sentences with page and speaker, for the guidance engine. */
  sentences?: Sentence[];
};

/** Annual reports are long: read up to 300 pages and 40 MB, which covers the notes in most. */
export const LIMITS: Record<DocKind, { maxPages: number; maxBytes: number }> = {
  annual_report: { maxPages: 300, maxBytes: 40 * 1024 * 1024 },
  transcript: { maxPages: 60, maxBytes: 15 * 1024 * 1024 },
  presentation: { maxPages: 60, maxBytes: 25 * 1024 * 1024 },
  results: { maxPages: 60, maxBytes: 15 * 1024 * 1024 },
  user: { maxPages: 300, maxBytes: 40 * 1024 * 1024 },
};

/**
 * Section headings that recur in Indian annual reports. A page belongs to the heading found in
 * its first lines (running headers usually carry it), else to the previous page's. Lines that
 * repeat across many pages are ignored first: designed reports print a navigation bar
 * ("Corporate Overview | Statutory Reports | Financial Statements") on every page. Approximate,
 * so citations call it a "detected section".
 */
const SECTION_HEADINGS: [RegExp, string][] = [
  [/management(?:'s|’s)?\s+discussion\s*(?:and|&)\s*analysis/i, "Management discussion and analysis"],
  [/independent auditor(?:'s|’s)?\s+report/i, "Independent auditor's report"],
  [/notes\s+(?:forming part of|to)\s+the\s+consolidated/i, "Notes to the consolidated financial statements"],
  [/notes\s+(?:forming part of|to)\s+the\s+(?:standalone\s+)?financial statements/i, "Notes to the financial statements"],
  [/consolidated\s+(?:balance sheet|statement of profit and loss|statement of cash flows?|cash flow statement)/i, "Consolidated financial statements"],
  [/standalone\s+(?:balance sheet|statement of profit and loss|statement of cash flows?|cash flow statement)/i, "Standalone financial statements"],
  [/report\s+on\s+corporate\s+governance|corporate\s+governance\s+report/i, "Corporate governance report"],
  [/business\s+responsibility\s+(?:(?:and|&)\s+sustainability\s+)?report/i, "Business responsibility report"],
  [/board(?:'s|’s)?\s+report|directors(?:'|’)?\s+report/i, "Board's report"],
  [/(?:chairman|chairperson|managing director|ceo)(?:'s|’s)?\s+(?:message|letter|statement|desk)|message\s+from\s+(?:the\s+)?(?:chairman|chairperson|managing director|ceo|executive\s+(?:vice[- ])?chair\w*)/i, "Leadership message"],
  [/corporate\s+overview|company\s+overview|about\s+us|who\s+we\s+are|at\s+a\s+glance/i, "Corporate overview"],
];

export function detectSections(pages: string[]): (string | undefined)[] {
  const drop = recurringLines(pages);
  let current: string | undefined;
  return pages.map((page) => {
    const head = page
      .split("\n")
      .filter((l) => !drop.has(l.replace(/\d+/g, "#").trim()))
      .join("\n")
      .slice(0, 400);
    const hit = SECTION_HEADINGS.find(([re]) => re.test(head));
    if (hit) current = hit[1];
    return current;
  });
}

const TARGET = 700;

/** Splits a page into ~700-character passages at sentence or line boundaries. */
function passages(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(“"])|\n+/);
  const out: string[] = [];
  let buf = "";
  for (const raw of parts) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (buf && buf.length + p.length + 1 > TARGET) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf} ${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function chunkDocument(ref: Pick<DocRef, "id" | "kind">, pages: string[]): { chunks: Chunk[]; sentences?: Sentence[] } {
  if (ref.kind === "transcript") {
    const sentences = transcriptSentences(pages);
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    // Passages are built from every fragment, so a quoted passage never skips a short sentence.
    for (const s of transcriptSentences(pages, { all: true })) {
      if (cur && cur.page === s.page && cur.speaker === s.speaker && cur.text.length + s.text.length < TARGET) {
        cur.text += ` ${s.text}`;
        continue;
      }
      cur = { id: `${ref.id}#${chunks.length + 1}`, docId: ref.id, page: s.page, text: s.text, ...(s.speaker ? { speaker: s.speaker } : {}) };
      chunks.push(cur);
    }
    return { chunks, sentences };
  }
  const sections = detectSections(pages);
  const chunks: Chunk[] = [];
  pages.forEach((page, i) => {
    for (const text of passages(page)) {
      if (text.length < 40) continue;
      chunks.push({ id: `${ref.id}#${chunks.length + 1}`, docId: ref.id, page: i + 1, text, ...(sections[i] ? { section: sections[i] } : {}) });
    }
  });
  return { chunks };
}

type Loader = typeof loadPdfText;

export async function ingestDocument(ref: DocRef, load: Loader = loadPdfText): Promise<IngestedDoc> {
  const limits = LIMITS[ref.kind];
  try {
    const text = (await load(ref.url, { maxPages: limits.maxPages, maxBytes: limits.maxBytes, companyHosts: true })).value;
    const coverage = { pagesRead: text.pages.length, totalPages: text.totalPages, truncated: text.truncated };
    if (!hasTextLayer(text)) {
      return { ...ref, status: "scanned", error: "Scanned PDF without a text layer; FINN does not OCR", coverage, pages: [], chunks: [] };
    }
    return { ...ref, status: "read", coverage, pages: text.pages, ...chunkDocument(ref, text.pages) };
  } catch (err) {
    return { ...ref, status: "failed", error: err instanceof Error ? err.message : "Unreadable", coverage: { pagesRead: 0, totalPages: 0, truncated: false }, pages: [], chunks: [] };
  }
}

/** Reads several documents, a few at a time (they are large and share hosts). */
export async function ingestAll(refs: DocRef[], load: Loader = loadPdfText, concurrency = 3): Promise<IngestedDoc[]> {
  const out: IngestedDoc[] = new Array(refs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, refs.length) }, async () => {
      while (next < refs.length) {
        const i = next++;
        out[i] = await ingestDocument(refs[i], load);
      }
    }),
  );
  return out;
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, " ").replace(/\s+/g, " ");

/**
 * Whether a document names the company anywhere: its first two name words ("kaynes
 * technology") or its NSE symbol as a word. A guard against another company's report or
 * transcript — pasted by an investor or mis-filed at the source — being read as this one's.
 */
export function namesCompany(pages: string[], name: string, symbol: string): boolean {
  const key = plain(name).split(" ").filter((w) => w && w !== "the").slice(0, 2).join(" ");
  const sym = plain(symbol).trim();
  return pages.some((page) => {
    const text = ` ${plain(page)} `;
    // The name must start a word; the symbol must be a whole word.
    return (key.length > 0 && text.includes(` ${key}`)) || (sym.length > 1 && text.includes(` ${sym} `));
  });
}

/**
 * Read documents that never name the company are set aside as failed, with the reason, so
 * they are neither searched, nor matched for figures, nor scored for guidance.
 */
export function keepCompanyDocs(docs: IngestedDoc[], name: string, symbol: string): IngestedDoc[] {
  return docs.map((d) =>
    d.status === "read" && !namesCompany(d.pages, name, symbol)
      ? { ...d, status: "failed", error: `It never names ${name} (${symbol}), so FINN did not use it — it may be another company's document`, pages: [], chunks: [], sentences: [] }
      : d,
  );
}
