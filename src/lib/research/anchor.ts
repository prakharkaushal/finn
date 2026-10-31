import type { Figure } from "@/lib/data/schema";

/**
 * Traces a figure from the standardised tables back to the page of a primary document that
 * reports it. Filings state numbers in ₹ crore, ₹ lakh or ₹ million, with decimals; the table
 * states ₹ crore, rounded. A page matches when a line carries the metric's label and that line
 * (or the next two, where a PDF splits a table row) holds a number equal to the figure in one of
 * those units, within rounding. Deterministic: no match, no page citation.
 */

const LABELS: Record<Figure["metric"], RegExp> = {
  // One garbled word is tolerated between "revenue" and "operations": results PDFs are often OCR'd ("Revenue froim operations").
  // Banks report "Interest earned" where others report revenue; the number must still match exactly.
  revenue: /revenue\s*\S{0,6}\s*operations|income\s*from\s*operations|net\s*sales|interest\s*earned/i,
  pat: /profit\s*(?:\/\s*\(loss\)\s*)?for the (?:year|period)|profit after tax|net profit/i,
  pbt: /profit\s*(?:\/\s*\(loss\)\s*)?before tax/i,
  ebitda: /\bebitda\b|earnings before interest,? tax(?:es)?,? depreciation/i,
  cfo: /net cash\s*(?:flows?\s*)?(?:generated\s*)?(?:from|\/\s*\(used in\)|\(used in\)|used in)\s*(?:\/\s*\(used in\)\s*)?operating activities|cash generated from operations/i,
};

const UNITS = [
  { unit: "₹ crore", factor: 1 },
  { unit: "₹ lakh", factor: 100 },
  { unit: "₹ million", factor: 10 },
];

const NUMBER = /\(?-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\)?|\(?-?\d+\.\d+\)?|\(?-?\d{2,}\)?/g;

export function parseNumber(raw: string): number | null {
  const negative = raw.startsWith("(") || raw.startsWith("-");
  const n = Number(raw.replace(/[(),\s-]/g, ""));
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

export type Anchor = { page: number; excerpt: string; unit: string };

/** True when `n`, read in some unit, is the ₹-crore figure within rounding. */
export function sameFigure(n: number, croreValue: number): string | null {
  for (const { unit, factor } of UNITS) {
    const target = croreValue * factor;
    if (Math.abs(n - target) <= 0.5 * factor + Math.abs(target) * 0.0005) return unit;
  }
  return null;
}

export function locateFigure(pages: string[], figure: Pick<Figure, "metric" | "value">, opts: { basis?: "consolidated" | "standalone" } = {}): Anchor | null {
  // Small numbers collide with page numbers, notes and percentages.
  if (Math.abs(figure.value) < 10) return null;
  const label = LABELS[figure.metric];
  const found: (Anchor & { rank: number })[] = [];
  pages.forEach((text, i) => {
    if (!label.test(text)) return;
    const consolidated = /consolidated/i.test(text.slice(0, 800));
    const rank = opts.basis === "consolidated" ? (consolidated ? 0 : 1) : opts.basis === "standalone" ? (consolidated ? 1 : 0) : 0;
    const lines = text.split("\n");
    lines.forEach((line, li) => {
      if (!label.test(line)) return;
      const windowLines = lines.slice(li, li + 3);
      for (const candidate of windowLines) {
        for (const m of candidate.matchAll(NUMBER)) {
          const n = parseNumber(m[0]);
          const unit = n == null ? null : sameFigure(n, figure.value);
          if (!unit) continue;
          const excerpt = (candidate === line ? line : `${line} … ${candidate}`).replace(/\s+/g, " ").trim().slice(0, 220);
          found.push({ page: i + 1, excerpt, unit, rank });
          return;
        }
      }
    });
  });
  found.sort((a, b) => a.rank - b.rank || a.page - b.page);
  const best = found[0];
  return best ? { page: best.page, excerpt: best.excerpt, unit: best.unit } : null;
}
