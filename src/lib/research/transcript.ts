/**
 * Turns per-page transcript text into sentences that remember their page and speaker,
 * so every quote FINN surfaces can be cited as "p. 7, CFO".
 */

export type Sentence = { text: string; page: number; speaker?: string; isQuestion: boolean };

const ABBREVIATIONS = ["Mr", "Ms", "Mrs", "Dr", "Rs", "No", "Nos", "vs", "approx", "e.g", "i.e", "Ltd", "Pvt", "Co", "Inc", "St", "Jr", "Sr", "viz", "etc", "Fig", "Sept", "Corp", "Govt"];
const ABBR_RE = new RegExp(`\\b(${ABBREVIATIONS.map((a) => a.replace(/\./g, "\\.")).join("|")})\\.`, "gi");
const DOT = "․";

const NOT_SPEAKERS = new Set(["note", "disclaimer", "sub", "subject", "ref", "date", "revenue", "ebitda", "pat", "q", "a", "time", "venue", "place", "website", "email", "e-mail", "tel", "phone", "cin", "for", "dear sir", "dear sirs"]);
const SPEAKER_LINE = /^((?:[A-Z][A-Za-z.'’-]*\.?\s?){1,5}):\s+(.*)$/;
const MARK = (name: string) => `⟦${name}⟧`;
const MARK_RE = /⟦([^⟧]+)⟧/g;

/** Lines that recur on many pages (letterheads, "Page x of y", copyright footers, navigation bars). */
export function recurringLines(pages: string[]): Set<string> {
  if (pages.length < 4) return new Set();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set(page.split("\n").map((l) => l.replace(/\d+/g, "#").trim()).filter((l) => l.length > 3));
    for (const l of seen) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([l]) => l));
}

/**
 * A line that is only the page's printed number ("19", "Page 19", "19 of 26"). recurringLines
 * ignores lines this short, and a number left in lands mid-quote ("representing growth 14 of
 * 2.2%"). Printed numbers can trail the PDF page index (an unnumbered cover), hence the ±2.
 */
export function isPageNumberLine(line: string, pageIndex: number): boolean {
  const m = line.trim().match(/^(?:page\s*)?(\d{1,3})(?:\s*(?:of|\/)\s*\d{1,3})?$/i);
  return m != null && Math.abs(Number(m[1]) - pageIndex) <= 2;
}

/**
 * `all` keeps every fragment, however short. Guidance scoring wants only substantial sentences;
 * passages must keep everything, or joining neighbours would silently drop words from a quote
 * ("one OEM in the U.S. and one in Japan." loses its short second "sentence").
 */
export function transcriptSentences(pages: string[], opts: { all?: boolean } = {}): Sentence[] {
  const drop = recurringLines(pages);
  let text = "";
  const pageStarts: number[] = [];
  pages.forEach((page, i) => {
    pageStarts.push(text.length);
    const lines = page.split("\n").filter((l) => !drop.has(l.replace(/\d+/g, "#").trim()) && !isPageNumberLine(l, i + 1));
    for (const line of lines) {
      const m = line.match(SPEAKER_LINE);
      const name = m?.[1].trim();
      if (m && name && !NOT_SPEAKERS.has(name.toLowerCase()) && name.length <= 48) {
        text += `\n${MARK(name)} ${m[2]} `;
      } else {
        text += `${line} `;
      }
    }
    text += "\n";
  });

  const pageAt = (offset: number) => {
    let p = 0;
    while (p + 1 < pageStarts.length && pageStarts[p + 1] <= offset) p++;
    return p + 1;
  };

  // Same-length substitution, so offsets still map to pages.
  const protectedText = text.replace(ABBR_RE, (m) => m.replace(".", DOT));
  const out: Sentence[] = [];
  let speaker: string | undefined;
  let offset = 0;
  for (const segment of protectedText.split(/(?=⟦[^⟧]+⟧)/)) {
    const marker = segment.match(/^⟦([^⟧]+)⟧/);
    if (marker) speaker = marker[1];
    const bodyStart = offset + (marker ? marker[0].length : 0);
    const body = marker ? segment.slice(marker[0].length) : segment;
    const emitSentence = (from: number, to: number) => {
      const sentence = body.slice(from, to).replace(MARK_RE, " ").replace(new RegExp(DOT, "g"), ".").replace(/\s+/g, " ").trim();
      if (opts.all ? !/[A-Za-z0-9]/.test(sentence) : sentence.length < 25 || !/[a-z]/.test(sentence)) return;
      out.push({ text: sentence, page: pageAt(bodyStart + from), speaker, isQuestion: /\?["”’)]?$/.test(sentence) });
    };
    // A sentence ends at . ! ? followed by whitespace — so "11.1%" and "Rs.5" stay whole.
    let start = 0;
    for (const b of body.matchAll(/[.!?]+["”’)]?(?=\s)/g)) {
      const end = (b.index ?? 0) + b[0].length;
      emitSentence(start, end);
      start = end;
    }
    if (start < body.length) emitSentence(start, body.length);
    offset += segment.length;
  }
  return out;
}

/** Normalised form for checking that a quote really appears in a source. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”"']/g, "")
    .replace(/[^a-z0-9%.]+/g, " ")
    .trim();
}

/** True when `quote` occurs (after normalisation) in the source text — the anti-fabrication check. */
export function quoteAppears(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(source).includes(q);
}
