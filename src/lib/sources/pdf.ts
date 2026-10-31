import { extractText, getDocumentProxy } from "unpdf";
import { cached, type Cached } from "@/lib/net/cache";
import { assertDocumentUrl, DOCUMENT_HOSTS, fetchBytes, isPublicHttpsUrl, SourceError } from "@/lib/net/http";

/**
 * Text extraction for exchange-hosted PDFs (transcripts, filings). Text is kept per page so
 * every quote FINN shows can be pinned to a page. Scanned PDFs have no text layer; they are
 * reported as unreadable rather than OCR'd.
 */

export type PdfText = { pages: string[]; totalPages: number; truncated: boolean };

export async function pdfToText(bytes: Uint8Array, maxPages = 80): Promise<PdfText> {
  // verbosity 0: pdf.js otherwise logs harmless font-hinting warnings for many filings.
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.slice(0, maxPages).map((p) => p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim());
  return { pages, totalPages, truncated: totalPages > maxPages };
}

export function hasTextLayer(doc: PdfText): boolean {
  const chars = doc.pages.reduce((n, p) => n + p.replace(/\s/g, "").length, 0);
  return chars > 200 * Math.min(doc.pages.length, 3);
}

/**
 * BSE's AnnPdfOpen.aspx redirector sometimes answers with a malformed header that Node's
 * strict HTTP parser rejects (curl tolerates it). The static file it redirects to is served
 * cleanly, so fetch that first: AttachHis for older filings, AttachLive for recent ones.
 */
export function documentUrlCandidates(url: string): string[] {
  const m = url.match(/^https:\/\/www\.bseindia\.com\/stockinfo\/AnnPdfOpen\.aspx\?Pname=([\w.-]+\.pdf)$/i);
  if (!m) return [url];
  const base = "https://www.bseindia.com/xml-data/corpfiling";
  return [`${base}/AttachHis/${m[1]}`, `${base}/AttachLive/${m[1]}`, url];
}

/**
 * Documents never change once filed: cache the extracted text forever, keyed by URL.
 * `companyHosts` admits company investor-relations sites (public https only) in addition
 * to the exchanges — used for transcript links that screener.in lists.
 */
export async function loadPdfText(
  url: string,
  opts: { maxPages?: number; maxBytes?: number; companyHosts?: boolean } = {},
): Promise<Cached<PdfText>> {
  if (opts.companyHosts) {
    if (!isPublicHttpsUrl(url)) throw new SourceError("Only public https documents can be read", "input", undefined, url);
  } else {
    assertDocumentUrl(url);
  }
  // A long read (annual reports) gets its own key, so a shorter earlier read is never served truncated.
  const key = (opts.maxPages ?? 80) > 80 ? `${url}#pages=${opts.maxPages}` : url;
  const big = (opts.maxBytes ?? 0) > 15 * 1024 * 1024;
  return cached(key, { namespace: "pdf-text", ttlMs: Infinity }, async () => {
    let lastError: unknown;
    for (const candidate of documentUrlCandidates(url)) {
      let bytes: Uint8Array;
      try {
        bytes = await fetchBytes(candidate, {
          source: "PDF",
          timeoutMs: big ? 90_000 : 30_000,
          retries: 1,
          maxBytes: opts.maxBytes ?? 15 * 1024 * 1024,
          allowHosts: opts.companyHosts ? "public" : DOCUMENT_HOSTS,
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      try {
        return await pdfToText(bytes, opts.maxPages);
      } catch (err) {
        throw new SourceError(`Could not read PDF (${err instanceof Error ? err.message : "parse error"})`, "PDF", undefined, url);
      }
    }
    throw lastError instanceof Error ? lastError : new SourceError("PDF unreachable", "PDF", undefined, url);
  });
}
