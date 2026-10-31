import { config, llmEnabled } from "@/lib/config";
import { instrumentKey, instrumentSlug, type Instrument } from "@/lib/data/instrument";
import type { CompanyFundamentals, Figure } from "@/lib/data/schema";
import { DataUnavailableError, dataNow, getAnnouncements, getDirectory, getFundamentals, getPrices, providerSet, runMode, type ProviderSet, type RunMode } from "@/lib/data/service";
import { classify } from "@/lib/domain/classify";
import { resultsPeriodEnd } from "@/lib/domain/extract";
import { displayName } from "@/lib/domain/names";
import { fyLabel, quarterOf, shiftQuarter } from "@/lib/domain/periods";
import { computeSignal, DEFAULT_THRESHOLDS } from "@/lib/domain/signals";
import { describeLlmError, type LlmCall } from "@/lib/llm/client";
import { buildThesis, structureGuidance } from "@/lib/llm/tasks";
import { cached, HOUR, peek } from "@/lib/net/cache";
import { locateFigure } from "@/lib/research/anchor";
import { businessSnapshot } from "@/lib/research/business";
import { buildCase } from "@/lib/research/case";
import { discoverDocuments, type ExtraSource } from "@/lib/research/discover";
import { analyzeFinancials } from "@/lib/research/financials";
import { dedupeStatements, detectRevisions, evaluate, findCandidates, parseGuidance, parsePeriod, scorecard } from "@/lib/research/guidance";
import { detectSections, ingestAll, keepCompanyDocs, type DocRef, type IngestedDoc } from "@/lib/research/ingest";
import { assess, checkClaimedActuals } from "@/lib/research/narrative";
import { buildIndex } from "@/lib/research/retrieve";
import type { Citation, Claim, GuidanceStatement, ResearchEvent, ResearchReport, SourceDoc, ThesisSection } from "@/lib/research/types";

type Emit = (e: ResearchEvent) => void;

export class ResearchError extends Error {}

function step(emit: Emit, id: string, label: string) {
  emit({ type: "step", id, label, status: "running" });
  return {
    done: (detail?: string) => emit({ type: "step", id, label, status: "done", detail }),
    skipped: (detail: string) => emit({ type: "step", id, label, status: "skipped", detail }),
    error: (detail: string) => emit({ type: "step", id, label, status: "error", detail }),
  };
}

/** "2026-08" → "Aug 2026". */
function monthLabel(month: string): string {
  return new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Forward-looking statements from the transcripts that were read, each pinned to its page and speaker. */
function statementsFrom(docs: IngestedDoc[]): GuidanceStatement[] {
  const statements: GuidanceStatement[] = [];
  for (const doc of docs) {
    if (doc.kind !== "transcript" || doc.status !== "read" || !doc.sentences || !doc.date) continue;
    const callLabel = `${monthLabel(doc.date)} call${doc.period ? ` · ${doc.period}` : ""}`;
    findCandidates(doc.sentences).forEach((sentence, i) => {
      statements.push({
        id: `${doc.id}-${i + 1}`,
        sourceId: doc.id,
        callLabel,
        callMonth: doc.date!,
        page: sentence.page,
        speaker: sentence.speaker,
        // Indian concall questioners address management as "Sir"/"Madam".
        voice: /^(sir|madam|ma'?am)\b/i.test(sentence.text) || /moderator/i.test(sentence.speaker ?? "") ? "analyst" : "management",
        quote: sentence.text,
        structuredBy: "none",
      });
    });
  }
  return statements;
}

/** The latest results filing on NSE for this company, from the announcements listings. */
async function latestResultsFiling(symbol: string, set: ProviderSet, directory: Awaited<ReturnType<typeof getDirectory>> | null): Promise<DocRef | null> {
  if (!directory) return null;
  const now = await dataNow(set);
  const outcomes = await getAnnouncements({ symbols: [symbol], from: now - 150 * 86_400_000, to: now, directory }, undefined, set);
  const filed = outcomes
    .flatMap((o) => (o.ok ? o.batch.items : []))
    .filter((a) => a.symbol === symbol && a.docType === "pdf" && classify(a.subject, a.description).subtype === "results_filed")
    .sort((a, b) => b.ts.localeCompare(a.ts));
  const r = filed[0];
  if (!r) return null;
  const periodEnd = resultsPeriodEnd(r.description, r.ts);
  const q = quarterOf(periodEnd);
  return { id: `results-${periodEnd}`, kind: "results", title: `Results filing, ${q?.label ?? periodEnd} (NSE)`, url: r.url, period: q?.label, periodEnd, date: r.ts.slice(0, 10) };
}

const METRIC_WORD: Record<Figure["metric"], string> = { revenue: "Revenue", pat: "PAT", pbt: "PBT", ebitda: "EBITDA", cfo: "Operating cash flow" };

/**
 * Traces each claim's figures to the primary document that reports them: the annual report for
 * a fiscal year (its own year or the next year's comparative column), the results filing for a
 * quarter (that quarter, the one before or the year-ago one). A located figure gives a page
 * citation with the excerpt; a document that was read but where the figure was not found gives a
 * document-level citation; the standardised table stays as the secondary source.
 */
export function anchorClaims(claims: Claim[], docs: IngestedDoc[], basis: "consolidated" | "standalone"): Claim[] {
  const sectionsOf = new Map(docs.map((d) => [d.id, detectSections(d.pages)]));
  return claims.map((c) => {
    const secondary = c.citations.map((x) => ({ ...x, level: x.level ?? ("section" as const) }));
    if (!c.figures?.length) return { ...c, citations: secondary };
    const primary: Citation[] = [];
    const seen = new Set<string>();
    for (const f of c.figures) {
      const candidates = docs.filter((d) =>
        d.status !== "read"
          ? false
          : f.quarter
            ? d.kind === "results" && !!d.periodEnd && [d.periodEnd, shiftQuarter(d.periodEnd, -1), shiftQuarter(d.periodEnd, -4)].includes(f.quarter)
            : d.kind === "annual_report" && d.fy != null && (d.fy === f.fy || d.fy === f.fy + 1),
      );
      let found = false;
      for (const d of candidates) {
        const a = locateFigure(d.pages, f, { basis });
        if (!a) continue;
        found = true;
        const key = `${d.id}:${a.page}`;
        if (!seen.has(key)) {
          seen.add(key);
          const section = sectionsOf.get(d.id)?.[a.page - 1];
          primary.push({ sourceId: d.id, page: a.page, excerpt: a.excerpt, level: "page", ...(a.unit !== "₹ crore" ? { unit: a.unit } : {}), ...(section ? { section } : {}) });
        }
        break;
      }
      if (!found && candidates[0] && !seen.has(candidates[0].id)) {
        seen.add(candidates[0].id);
        primary.push({ sourceId: candidates[0].id, level: "document", section: `${METRIC_WORD[f.metric]} ${f.quarter ? (quarterOf(f.quarter)?.label ?? f.quarter) : fyLabel(f.fy)} not located on a page` });
      }
    }
    return { ...c, citations: [...primary, ...secondary] };
  });
}

function sourceDocFor(d: IngestedDoc | DocRef, read: IngestedDoc | undefined, mode: RunMode): SourceDoc {
  const kind = d.kind === "user" ? "user" : d.kind;
  const base = { id: d.id, kind, title: d.title, url: d.url, period: d.period, primary: true } as const;
  if (mode === "demo") return { ...base, status: "listed", note: "Not read in demo mode" };
  if (!read) return { ...base, status: "listed", note: "Not read: FINN reads the latest annual report, the last four calls, the latest presentation and results filing" };
  const coverage = read.coverage;
  // Coverage ("300 of 321 pages read") is shown from `coverage`; no separate note.
  if (read.status === "read") return { ...base, status: "used", pages: coverage.totalPages, coverage };
  return { ...base, status: "failed", pages: coverage.totalPages || undefined, coverage, note: read.error ?? "Could not be read" };
}

/** "Read the FY26 annual report (300 of 312 pages), 4 call transcripts and the Q1 FY27 results filing; 1 document could not be read." */
export function coverageLine(docs: IngestedDoc[], mode: RunMode): string {
  if (mode === "demo") return "Demo mode reads no documents: the financial views below come from the demo dataset, and guidance and the business snapshot need live mode.";
  const read = docs.filter((d) => d.status === "read");
  const parts: string[] = [];
  const ar = read.filter((d) => d.kind === "annual_report");
  for (const d of ar) parts.push(`the ${d.period ?? ""} annual report (${d.coverage.truncated ? `${d.coverage.pagesRead} of ${d.coverage.totalPages}` : d.coverage.totalPages} pages)`.replace("the  ", "the "));
  const calls = read.filter((d) => d.kind === "transcript").length;
  if (calls) parts.push(`${calls} call transcript${calls === 1 ? "" : "s"}`);
  for (const d of read.filter((x) => x.kind === "results")) parts.push(`the ${d.period ?? ""} results filing`);
  for (const d of read.filter((x) => x.kind === "presentation")) parts.push(`the ${d.date ? monthLabel(d.date) : ""} investor presentation`);
  const other = read.filter((x) => x.kind === "user").length;
  if (other) parts.push(`${other} document${other === 1 ? "" : "s"} you added`);
  const failed = docs.filter((d) => d.status !== "read").length;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "no primary documents");
  return `Read ${list}${failed ? `; ${failed} document${failed === 1 ? "" : "s"} could not be read (see Sources)` : ""}.`;
}

/** Rules first; the fast model only sees sentences the rules could not structure. */
async function structureAndScore(statements: GuidanceStatement[], company: CompanyFundamentals, emit: Emit, warnings: string[], calls: LlmCall[]) {
  const s = step(emit, "guidance", "Checking promises against reported numbers");
  const expanded: GuidanceStatement[] = [];
  const leftovers: GuidanceStatement[] = [];
  for (const st of statements) {
    const parsed = parseGuidance(st.quote, company.name);
    if (!parsed.length) {
      leftovers.push(st);
      continue;
    }
    parsed.forEach((p, i) => {
      const period = parsePeriod(st.quote, st.callMonth, p.at);
      expanded.push({
        ...st,
        id: parsed.length > 1 ? `${st.id}${String.fromCharCode(97 + i)}` : st.id,
        metric: p.metric,
        low: p.low,
        high: p.high,
        unit: p.unit,
        interpreted: p.interpreted,
        segment: p.segment,
        period: period ?? undefined,
        structuredBy: "rules",
      });
    });
  }

  let llmNote = "";
  if (leftovers.length && llmEnabled()) {
    try {
      const out = await structureGuidance(leftovers.map((l) => ({ id: l.id, quote: l.quote })));
      calls.push(...out.calls);
      const byId = new Map(out.results.map((r) => [r.id, r]));
      for (const l of leftovers) {
        const r = byId.get(l.id);
        expanded.push(
          r
            ? { ...l, metric: r.metric, low: r.low, high: r.high, unit: r.unit, period: parsePeriod(r.periodText ?? l.quote, l.callMonth) ?? undefined, structuredBy: "llm" }
            : l,
        );
      }
      llmNote = ` · ${out.results.length} more structured by ${config.llm.fastModel}${out.dropped ? `, ${out.dropped} rejected (numbers not in quote)` : ""}`;
    } catch (err) {
      warnings.push(`Guidance structuring skipped: ${describeLlmError(err)}`);
      expanded.push(...leftovers);
    }
  } else {
    expanded.push(...leftovers);
  }

  const unique = dedupeStatements(expanded);
  for (const st of unique) if (st.metric) st.verdict = evaluate(st, company);
  const structured = unique.filter((x) => x.metric);
  s.done(`${structured.length} quantified statements scored${llmNote}`);
  return unique;
}

async function thesisStep(company: string, claims: Claim[], statements: GuidanceStatement[], mode: RunMode, emit: Emit, warnings: string[], calls: LlmCall[]): Promise<ThesisSection | null> {
  const s = step(emit, "thesis", "Writing a cited bull and bear case");
  if (mode === "demo" || !llmEnabled()) {
    s.skipped(mode === "demo" ? "Demo mode makes no model calls" : "No LLM configured — the deterministic analysis above stands on its own");
    return null;
  }
  try {
    const out = await buildThesis({ company, claims, statements: statements.filter((x) => x.verdict && x.verdict.status !== "not_comparable") });
    calls.push(...out.calls);
    s.done(out.dropped ? `${out.dropped} uncited points dropped` : undefined);
    return { bull: out.bull, bear: out.bear, divergences: out.divergences, model: config.llm.reasoningModel, generatedAt: new Date().toISOString(), dropped: out.dropped };
  } catch (err) {
    const msg = describeLlmError(err);
    warnings.push(`Bull/bear synthesis skipped: ${msg}`);
    s.error(msg);
    return null;
  }
}

function priceSourceUrl(providerSymbol: string, provider: string, url: string): string {
  return provider === "yahoo-chart" ? `https://finance.yahoo.com/quote/${encodeURIComponent(providerSymbol)}` : url;
}

export async function buildReport(instrument: Instrument, emit: Emit, opts: { extras?: ExtraSource[]; set?: ProviderSet } = {}): Promise<ResearchReport> {
  const set = opts.set ?? providerSet();
  const warnings: string[] = [];
  const llmCalls: LlmCall[] = [];
  const symbol = instrument.code;
  const slug = instrumentSlug(instrument);

  const s1 = step(emit, "company", "Finding the company");
  const directory = await getDirectory(undefined, set).catch(() => null);
  const listed = directory?.index.bySymbol.get(symbol);
  if (directory && !listed) {
    const why =
      instrument.exchange === "BSE"
        ? `${slug}: FINN reads statements by NSE symbol, and ${symbol} is not on NSE's equity list. BSE-only companies are not covered by research yet.`
        : `${symbol} is not an NSE-listed equity (checked NSE's master list as of ${directory.source.retrievedAt.slice(0, 10)}).`;
    s1.error(why);
    throw new ResearchError(why);
  }
  let company: CompanyFundamentals;
  try {
    company = await getFundamentals(symbol, undefined, set);
  } catch (err) {
    const msg =
      err instanceof DataUnavailableError && err.noData
        ? set.mode === "demo"
          ? `${symbol} is not in the demo dataset. Demo research covers the demo portfolio and the four precomputed picks; switch to live data to research any NSE company.`
          : `${symbol} has no page on screener.in, so its statements aren't available`
        : `Statements unavailable (${err instanceof Error ? err.message : "error"})`;
    s1.error(msg);
    throw new ResearchError(msg);
  }
  const name = listed ? displayName(listed.name) : company.name;
  s1.done(`${name} · ${company.basis} statements${company.source.mode === "live" || company.source.mode === "cache" ? "" : ` (${company.source.mode})`}`);

  const s2 = step(emit, "financials", "Computing growth, margins, leverage and cash conversion");
  const fin = analyzeFinancials(company);
  s2.done();

  const s3 = step(emit, "prices", "Fetching end-of-day prices");
  let price: ResearchReport["price"];
  try {
    const series = await getPrices(instrument, undefined, set);
    const sig = computeSignal(series.bars, DEFAULT_THRESHOLDS, { sessionOpen: series.sessionOpen });
    // Completed sessions only, like the alert rules: a half-day bar is not a close.
    const complete = sig?.excludedPartialSession ? series.bars.slice(0, -1) : series.bars;
    const closes = complete.slice(-250).map((b) => b.close);
    const label = set.prices.find((p) => p.id === series.source.provider)?.label ?? series.source.provider;
    if (sig) {
      price = {
        close: sig.close,
        changePct: sig.changePct,
        date: sig.date,
        spark: complete.slice(-120).map((b) => b.close),
        // A 52-week range needs a year of sessions; shorter series (bhavcopy) say nothing rather than mislead.
        high52: closes.length >= 200 ? Math.max(...closes) : null,
        low52: closes.length >= 200 ? Math.min(...closes) : null,
        source: { ...series.source, url: priceSourceUrl(series.providerSymbol, series.source.provider, series.source.url), label, adjustment: series.adjustment.close },
      };
    }
    s3.done(`${label} · ${series.providerSymbol}${series.source.mode === "live" || series.source.mode === "cache" ? "" : ` (${series.source.mode})`}`);
  } catch (err) {
    warnings.push(`Prices unavailable: ${err instanceof Error ? err.message : "error"}`);
    s3.error("Prices unavailable");
  }

  // ---- Primary documents: discover, then read
  const s4 = step(emit, "sources", "Finding the company's own documents");
  const results = await latestResultsFiling(symbol, set, directory).catch(() => null);
  const discovery = discoverDocuments(company, results, opts.extras ?? []);
  const kinds = (k: DocRef["kind"]) => discovery.selected.filter((d) => d.kind === k).length;
  s4.done(
    discovery.selected.length
      ? `${kinds("annual_report")} annual report, ${kinds("transcript")} transcripts, ${kinds("presentation")} presentation, ${kinds("results")} results filing${opts.extras?.length ? `, ${opts.extras.length} added by you` : ""}`
      : "No primary documents found",
  );
  let docs: IngestedDoc[] = [];
  const s5 = step(emit, "documents", "Reading the documents");
  if (set.mode === "demo") {
    s5.skipped("Demo mode reads nothing from the network; documents are listed, not read");
  } else if (!discovery.selected.length) {
    s5.skipped("Nothing to read — add an annual report or transcript under Sources");
  } else {
    docs = keepCompanyDocs(await ingestAll(discovery.selected), name, symbol);
    const read = docs.filter((d) => d.status === "read");
    const pages = read.reduce((n, d) => n + d.coverage.pagesRead, 0);
    s5.done(`${read.length} of ${docs.length} read · ${pages.toLocaleString("en-IN")} pages${docs.length > read.length ? ` · ${docs.length - read.length} unreadable` : ""}`);
    for (const d of docs) if (d.status !== "read") warnings.push(`${d.title}: ${d.error}`);
  }
  const index = buildIndex(docs);

  const statements = await structureAndScore(statementsFrom(docs), company, emit, warnings, llmCalls);
  for (const st of statements) {
    if (!st.metric || !st.verdict) continue;
    const a = assess(st);
    st.assessment = a.assessment;
    st.assessmentNote = a.note;
  }
  const checks = checkClaimedActuals(
    docs.filter((d) => d.kind === "transcript" && d.status === "read" && d.date).map((d) => ({ sourceId: d.id, callMonth: d.date!, sentences: d.sentences ?? [] })),
    company,
  );

  const anchored = {
    headline: anchorClaims(fin.headline, docs, company.basis),
    trajectory: { ...fin.trajectory, claims: anchorClaims(fin.trajectory.claims, docs, company.basis) },
    balanceSheet: { ...fin.balanceSheet, claims: anchorClaims(fin.balanceSheet.claims, docs, company.basis) },
    cash: { ...fin.cash, claims: anchorClaims(fin.cash.claims, docs, company.basis) },
    workingCapital: { ...fin.workingCapital, claims: anchorClaims(fin.workingCapital.claims, docs, company.basis) },
  };
  const allClaims = [...anchored.headline, ...anchored.trajectory.claims, ...anchored.balanceSheet.claims, ...anchored.cash.claims, ...anchored.workingCapital.claims];
  const business = businessSnapshot(docs, index, { demo: set.mode === "demo", company: name });
  const thesis = await thesisStep(name, allClaims, statements, set.mode, emit, warnings, llmCalls);

  const readById = new Map(docs.map((d) => [d.id, d]));
  const sources: SourceDoc[] = [
    { id: "screener", kind: "screener", title: `screener.in — standardised ${company.basis} statements and document links (secondary)`, url: company.url, status: "used", primary: false },
    ...discovery.selected.map((d) => sourceDocFor(d, readById.get(d.id), set.mode)),
    ...discovery.listed.map((d) => sourceDocFor(d, undefined, set.mode)),
    ...company.documents
      .filter((d) => d.kind === "ir_website")
      .map((w) => ({ id: w.id, kind: "ir_website" as const, title: w.title, url: w.url, status: "listed" as const, primary: true, note: "Entry point only; FINN does not crawl company sites — add a document from it under Sources" })),
  ];
  if (price?.source) sources.push({ id: "prices", kind: "prices", title: `End-of-day prices (${price.source.label})`, url: price.source.url, status: "used", primary: false });

  const transcriptDocs = discovery.selected.filter((d) => d.kind === "transcript");
  const transcriptsRead = docs.filter((d) => d.kind === "transcript" && d.status === "read").length;
  const guidanceStatus = set.mode === "demo" && transcriptDocs.length ? "skipped" : transcriptDocs.length === 0 ? "no_transcripts" : transcriptsRead === 0 ? "unreadable" : "ok";
  return {
    symbol,
    exchange: instrument.exchange,
    name,
    generatedAt: new Date().toISOString(),
    provenance: set.mode === "demo" ? "demo" : "live",
    basis: company.basis,
    isLender: company.isLender,
    units: company.units,
    statementsSource: company.source,
    price,
    topRatios: company.topRatios,
    ...fin,
    ...anchored,
    guidance: {
      status: guidanceStatus,
      transcriptsRead,
      statements,
      revisions: detectRevisions(statements),
      scorecard: scorecard(statements),
      note:
        guidanceStatus === "no_transcripts"
          ? "No earnings-call transcripts were found for this company. Add one under Sources to check guidance."
          : guidanceStatus === "skipped"
            ? "Demo mode reads nothing from the network. The transcripts are linked under Sources; run in live mode to check guidance."
            : undefined,
    },
    business,
    checks,
    case: buildCase({ claims: allClaims, statements, checks }),
    coverage: coverageLine(docs, set.mode),
    thesis,
    sources,
    warnings,
    llm: { enabled: llmEnabled(), used: llmCalls.length > 0, fastModel: config.llm.fastModel, reasoningModel: config.llm.reasoningModel, calls: llmCalls.length },
  };
}

/** Bump when parsing, scoring or the report shape changes, so reports built by older logic are not served. */
const REPORT_VERSION = 8;

/**
 * Serve order: a fresh live report from cache → the committed snapshot (instant demo) → build
 * live. `refresh` always builds live, and so do sources the investor added. Demo mode serves
 * the seed only and never fetches.
 */
export async function getReport(instrument: Instrument, opts: { refresh: boolean; emit: Emit; extras?: ExtraSource[]; set?: ProviderSet }): Promise<ResearchReport> {
  const set = opts.set ?? providerSet();
  const extras = opts.extras ?? [];
  if (set.mode === "demo") {
    if (opts.refresh || extras.length) {
      throw new ResearchError(
        runMode() === "demo"
          ? "Rebuilding or adding sources is off: this deployment serves demo data only (FINN_DATA_MODE=demo)."
          : "Rebuilding or adding sources needs live data. Switch to live data (the Demo data badge at the top, or Settings) and try again.",
      );
    }
    const seeded = instrument.exchange === "NSE" ? await set.seed.research(instrument.code) : null;
    if (seeded) return { ...seeded, provenance: "demo" };
    return buildReport(instrument, opts.emit, { set });
  }
  const namespace = `research-v${REPORT_VERSION}`;
  const key = extras.length ? `${instrumentKey(instrument)}|${JSON.stringify(extras)}` : instrumentKey(instrument);
  const ttmMs = 6 * HOUR;
  if (!opts.refresh) {
    const fresh = await peek<ResearchReport>(namespace, key, ttmMs);
    if (fresh) return fresh.value;
    const snapshot = instrument.exchange === "NSE" && !extras.length ? await set.seed.research(instrument.code) : null;
    if (snapshot) return { ...snapshot, provenance: "snapshot" };
  }
  const result = await cached(key, { namespace, ttlMs: opts.refresh ? 0 : ttmMs }, () => buildReport(instrument, opts.emit, { extras, set }));
  return result.value;
}
