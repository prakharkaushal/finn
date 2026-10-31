import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { StatementTable } from "@/lib/data/schema";
import { cached, MINUTE, type Cached } from "@/lib/net/cache";
import { fetchText, SourceError } from "@/lib/net/http";

/**
 * screener.in company pages: standardised multi-year statements compiled from company
 * filings, plus links to the primary documents (annual reports, concall transcripts).
 * Only /company/<SYMBOL>/ pages are read — the paths robots.txt leaves open. This module
 * fetches and parses raw pages; the fundamentals adapter normalises them.
 */

export type Period = { key: string; label: string };
export type FinTable = StatementTable;
export type DocLink = { title: string; url: string; date?: string };
export type AnnualReport = { year: number; url: string; source: string };
export type Concall = { label: string; month: string; transcriptUrl?: string; pptUrl?: string; recordingUrl?: string };

export type ScreenerCompany = {
  symbol: string;
  name: string;
  url: string;
  basis: "consolidated" | "standalone";
  isLender: boolean;
  bseCode?: string;
  website?: string;
  units: string;
  topRatios: { name: string; value: string }[];
  quarters: FinTable;
  annual: FinTable;
  balanceSheet: FinTable;
  cashFlow: FinTable;
  ratios: FinTable;
  announcements: DocLink[];
  annualReports: AnnualReport[];
  concalls: Concall[];
  creditRatings: DocLink[];
};

const BASE = "https://www.screener.in";

export function screenerUrl(symbol: string, basis: "consolidated" | "standalone") {
  const s = encodeURIComponent(symbol);
  return basis === "consolidated" ? `${BASE}/company/${s}/consolidated/` : `${BASE}/company/${s}/`;
}

/** "Net Profit +" → "net profit"; "CFO/EBITDA   Share of operating…" → "cfo/ebitda". */
export function rowKey(label: string): string {
  return label
    .replace(/ /g, " ")
    .trim()
    .split(/\s{2,}/)[0]
    .replace(/\+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** "1,23,456" / "-64,706" / "18%" / "" → number | null. */
export function parseCell(text: string): number | null {
  const t = text.replace(/[,\s %₹]/g, "");
  if (!t || t === "-" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function text($: cheerio.CheerioAPI, el: AnyNode) {
  return $(el).text().replace(/\s+/g, " ").trim();
}

function parseTable($: cheerio.CheerioAPI, sectionId: string): FinTable {
  const table = $(`section#${sectionId} table.data-table`).first();
  const periods: Period[] = [];
  table.find("thead th").each((i, th) => {
    if (i === 0) return;
    const label = text($, th);
    const key = $(th).attr("data-date-key") ?? label;
    periods.push({ key, label });
  });
  const rows: Record<string, (number | null)[]> = {};
  const order: string[] = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td").toArray();
    if (cells.length < 2) return;
    const key = rowKey($(cells[0]).text());
    if (!key || key === "raw pdf" || rows[key]) return;
    rows[key] = cells.slice(1, periods.length + 1).map((c) => parseCell($(c).text()));
    order.push(key);
  });
  return { periods, rows, order };
}

function monthOf(label: string): string {
  const m = label.match(/([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return "";
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const idx = months.indexOf(m[1].toLowerCase());
  return idx < 0 ? "" : `${m[2]}-${String(idx + 1).padStart(2, "0")}`;
}

export function parseScreenerPage(html: string, symbol: string, basis: "consolidated" | "standalone"): ScreenerCompany {
  const $ = cheerio.load(html);
  const name = $("h1").first().text().replace(/\s+/g, " ").trim() || symbol;

  const topRatios = $("#top-ratios li")
    .toArray()
    .map((li) => ({ name: text($, $(li).find(".name").get(0)!), value: text($, $(li).find(".value").get(0)!) }))
    .filter((r) => r.name);

  const bseHref = $('a[href*="bseindia.com/stock-share-price/"]').attr("href") ?? "";
  const bseCode = bseHref.match(/\/(\d{6})\/?$/)?.[1];
  const website = $('a[href^="http"]:has(i.icon-link)').first().attr("href");

  const quarters = parseTable($, "quarters");
  const sub = $("section#quarters p.sub").first().text().replace(/\s+/g, " ");
  const units = /lakh/i.test(sub) ? "₹ lakh" : "₹ crore";

  const announcements: DocLink[] = $("#company-announcements-tab ul.list-links li a")
    .toArray()
    .map((a) => {
      const el = $(a);
      const title = el.clone().children("div").remove().end().text().replace(/\s+/g, " ").trim();
      return { title, url: el.attr("href") ?? "", date: el.find("time").attr("datetime") };
    })
    .filter((d) => d.url && d.title);

  const annualReports: AnnualReport[] = $(".documents.annual-reports ul.list-links li a")
    .toArray()
    .flatMap((a) => {
      const label = text($, a);
      const year = Number(label.match(/(\d{4})/)?.[1]);
      const url = $(a).attr("href") ?? "";
      const source = $(a).parent().find(".ink-600").first().text().replace(/from/i, "").trim() || "exchange";
      return year && url.toLowerCase().endsWith(".pdf") ? [{ year, url, source }] : [];
    });

  const concalls: Concall[] = $(".documents.concalls ul.list-links li")
    .toArray()
    .map((li) => {
      const row = $(li);
      const label = text($, row.children("div").first().get(0)!);
      const link = (re: RegExp) =>
        row
          .find("a")
          .toArray()
          .find((a) => re.test($(a).text().trim()) || re.test($(a).attr("title") ?? ""))
          ?.attribs.href;
      return {
        label,
        month: monthOf(label),
        transcriptUrl: link(/transcript/i),
        pptUrl: link(/^ppt$/i),
        recordingUrl: link(/^rec$/i),
      };
    })
    .filter((c) => c.label);

  const creditRatings: DocLink[] = $(".documents.credit-ratings ul.list-links li a")
    .toArray()
    .map((a) => ({ title: $(a).clone().children("div").remove().end().text().replace(/\s+/g, " ").trim(), url: $(a).attr("href") ?? "", date: text($, $(a).find("div").get(0) ?? a) }))
    .filter((d) => d.url);

  return {
    symbol,
    name,
    url: screenerUrl(symbol, basis),
    basis,
    isLender: "financing profit" in quarters.rows || "financing profit" in parseTable($, "profit-loss").rows,
    bseCode,
    website,
    units,
    topRatios,
    quarters,
    annual: parseTable($, "profit-loss"),
    balanceSheet: parseTable($, "balance-sheet"),
    cashFlow: parseTable($, "cash-flow"),
    ratios: parseTable($, "ratios"),
    announcements,
    annualReports,
    concalls: dedupeConcalls(concalls),
    creditRatings,
  };
}

/** Screener sometimes lists the same transcript twice (e.g. two rows for one call). */
function dedupeConcalls(list: Concall[]): Concall[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = c.transcriptUrl ?? `${c.label}|${c.pptUrl ?? ""}|${c.recordingUrl ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every screener company page carries its ratio block, even one with no consolidated statements.
 * A page without it is an error, maintenance or access page served with a 200: it must fail
 * (so the chain falls back, labelled) rather than parse into a company with empty tables.
 */
export function assertCompanyPage(html: string, url: string): string {
  if (!html.includes('id="top-ratios"')) {
    throw new SourceError("screener.in returned a page that is not a company page (an error or access page)", "screener.in", 502, url);
  }
  return html;
}

/** Raw HTML is cached per page; parses are memoised per fetched copy, so a cached page is parsed once. Only company pages are cached. */
async function page(url: string, maxAgeMs?: number): Promise<Cached<string>> {
  return cached(url, { namespace: "screener-html-v1", ttlMs: maxAgeMs ?? 30 * MINUTE }, async () => assertCompanyPage(await fetchText(url, { source: "screener.in", timeoutMs: 12_000 }), url));
}

const parsed = new Map<string, ScreenerCompany>();
function parseOnce(raw: Cached<string>, symbol: string, basis: "consolidated" | "standalone"): ScreenerCompany {
  const key = `${symbol}:${basis}:${raw.fetchedAt}`;
  let company = parsed.get(key);
  if (!company) {
    company = parseScreenerPage(raw.value, symbol, basis);
    if (parsed.size > 60) parsed.delete(parsed.keys().next().value!);
    parsed.set(key, company);
  }
  return company;
}

export async function loadScreenerCompany(symbol: string, opts: { maxAgeMs?: number } = {}): Promise<Cached<ScreenerCompany>> {
  try {
    const cons = await page(screenerUrl(symbol, "consolidated"), opts.maxAgeMs);
    const consolidated = parseOnce(cons, symbol, "consolidated");
    // Companies without subsidiaries publish no consolidated statements; use standalone.
    if (consolidated.quarters.periods.length > 0 && consolidated.annual.periods.length > 0) return { ...cons, value: consolidated };
    const stand = await page(screenerUrl(symbol, "standalone"), opts.maxAgeMs);
    return { ...stand, value: parseOnce(stand, symbol, "standalone") };
  } catch (err) {
    if (err instanceof SourceError && err.status === 404) {
      throw new SourceError(`${symbol} was not found on screener.in`, "screener.in", 404);
    }
    throw err;
  }
}
