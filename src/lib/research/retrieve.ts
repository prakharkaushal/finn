import type { Chunk, DocKind, IngestedDoc } from "@/lib/research/ingest";

/**
 * Lexical retrieval (BM25) over one company's ingested primary documents. An index is built
 * from the documents FINN read for this report only, so a search can never return a passage
 * from another company or from a secondary source. No embeddings: no extra setup or cost, and
 * every hit is a verbatim passage with its page.
 */

const STOP = new Set(
  "a an and are as at be been by for from has have in into is it its of on or that the their this to was were will with we our us they which also than these those such other over per".split(" "),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t))
    .map((t) => t.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, ""));
}

export type SearchIndex = {
  chunks: Chunk[];
  kinds: Map<string, DocKind>;
  tfs: Map<string, number>[];
  lengths: number[];
  df: Map<string, number>;
  avgLength: number;
};

/** Only documents FINN actually read go in; failed or scanned ones have no chunks. */
export function buildIndex(docs: IngestedDoc[]): SearchIndex {
  const chunks = docs.filter((d) => d.status === "read").flatMap((d) => d.chunks);
  const kinds = new Map(docs.map((d) => [d.id, d.kind]));
  const df = new Map<string, number>();
  const tfs = chunks.map((c) => {
    const tf = new Map<string, number>();
    for (const t of tokens(c.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const lengths = tfs.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
  const avgLength = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  return { chunks, kinds, tfs, lengths, df, avgLength };
}

export type SearchOptions = {
  kinds?: DocKind[];
  docIds?: string[];
  limit?: number;
  /** Extra weight per chunk (e.g. favour a section); multiplied into the BM25 score. */
  boost?: (c: Chunk) => number;
};

export function search(index: SearchIndex, query: string, opts: SearchOptions = {}): { chunk: Chunk; score: number }[] {
  const q = [...new Set(tokens(query))];
  const n = index.chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  const hits: { chunk: Chunk; score: number }[] = [];
  index.chunks.forEach((chunk, i) => {
    if (opts.kinds && !opts.kinds.includes(index.kinds.get(chunk.docId)!)) return;
    if (opts.docIds && !opts.docIds.includes(chunk.docId)) return;
    const tf = index.tfs[i];
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const df = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.lengths[i]) / (index.avgLength || 1)));
    }
    if (score <= 0) return;
    hits.push({ chunk, score: score * (opts.boost?.(chunk) ?? 1) });
  });
  return hits.sort((x, y) => y.score - x.score).slice(0, opts.limit ?? 5);
}
