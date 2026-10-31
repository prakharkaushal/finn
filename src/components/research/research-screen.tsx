"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { formatCrore, formatCroreInr } from "@/lib/domain/numbers";
import type { ExtraSource } from "@/lib/research/discover";
import { ASSESSMENT_RULE } from "@/lib/research/narrative";
import type { ResearchReport, SourceDoc } from "@/lib/research/types";
import { dateTime, shortDate } from "@/lib/format";
import { useClientNow } from "@/components/client-time";
import { CheckIcon, ChevronDownIcon, ChevronIcon, RefreshIcon } from "@/components/icons";
import { BarChart, SeriesTable } from "@/components/research/charts";
import { AddSourceForm, BusinessView, CaseView, ClaimList, NarrativeView, SourcesList } from "@/components/research/evidence";
import { ReportSection, ThesisBlock, type SourceMap } from "@/components/research/sections";
import type { ResearchStep } from "@/components/research/use-research";
import { PageFrame } from "@/components/shell";
import { Button, ButtonLink, cx, Pct, ProvenanceBadge, ProvenanceDot, Skeleton, Sparkline, StatusNotice, type DisplayProvenance } from "@/components/ui";

export type ResearchScreenProps = {
  symbol: string;
  steps: ResearchStep[];
  report: ResearchReport | null;
  error: string | null;
  loading: boolean;
  inPortfolio: boolean;
  onToggleWatch: () => void;
  onRebuild: () => void;
  onRetry: () => void;
  view: ResearchView;
  onView: (v: ResearchView) => void;
  extras: ExtraSource[];
  onAddSource: (e: ExtraSource) => void;
  onRemoveSource: (url: string) => void;
  sampleNotice?: string;
  /** Offered when a live build fails and this visit may switch to the committed demo dataset. */
  onUseDemo?: () => void;
  /** Offered in demo data when the ticker is not in the demo dataset and this visit may switch to live data. */
  onUseLive?: () => void;
};

/** The focused views a report offers; one shows at a time (?view= in the URL). */
export const VIEWS = [
  ["business", "Business"],
  ["financials", "Financials"],
  ["balance", "Balance sheet & cash"],
  ["narrative", "Narrative vs numbers"],
  ["case", "Bull vs bear"],
  ["sources", "Sources"],
] as const;
export type ResearchView = (typeof VIEWS)[number][0];

export function isResearchView(v: string | null): v is ResearchView {
  return VIEWS.some(([id]) => id === v);
}

const crore = (v: number) => formatCroreInr(v, 0, "");
const pct1 = (v: number) => `${v.toFixed(1)}%`;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
/** "Q2 FY25" → two chart lines; tables keep it on one. */
const quarterLines = (l: string) => l.replace(" FY", "\nFY");

/** A live report served from FINN's cache after this long is labelled cached, with its build time. */
const CACHED_AFTER_MIN = 10;

function useCachedAge(report: ResearchReport): boolean {
  const now = useClientNow();
  return report.provenance === "live" && now != null && (now - Date.parse(report.generatedAt)) / 60_000 > CACHED_AFTER_MIN;
}

function Progress({ steps }: { steps: ResearchStep[] }) {
  return (
    <ol className="space-y-3" aria-live="polite" aria-label="Research progress">
      {steps.map((s) => (
        <li key={s.id} className="flex gap-3 text-[14.5px]">
          <span
            className={cx(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[12px]",
              s.status === "done" && "border-up bg-up-soft text-up",
              s.status === "running" && "border-accent",
              s.status === "skipped" && "border-line-strong text-muted",
              s.status === "error" && "border-down bg-down-soft text-down",
            )}
            aria-hidden="true"
          >
            {s.status === "done" ? <CheckIcon size={12} /> : s.status === "running" ? <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> : s.status === "error" ? "!" : "–"}
          </span>
          <span>
            <span className={s.status === "running" ? "font-medium text-ink" : "text-muted"}>
              {s.label}
              <span className="sr-only"> — {s.status}</span>
            </span>
            {s.detail && <span className="t-meta block">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "none" is an absence that is not a failure: synthesis switched off, no presentation published. */
type StatusRow = { label: string; value: ReactNode; provenance: DisplayProvenance | "none" };

/** "Aug 2026" from "Earnings-call transcript, Aug 2026 call · Q1 FY27". Sources arrive newest first. */
function latestCall(report: ResearchReport): { label: string; ageDays: number } | null {
  const label = report.sources.find((s) => s.kind === "transcript")?.title.match(/, ([A-Z][a-z]{2} \d{4}) call/)?.[1];
  if (!label) return null;
  const when = Date.parse(`1 ${label}`);
  return { label, ageDays: Number.isFinite(when) ? (Date.parse(report.generatedAt) - when) / 86_400_000 : 0 };
}

/** The document of a kind FINN tried to read (read or failed first), else the newest one linked. */
function docOf(report: ResearchReport, kind: SourceDoc["kind"]): SourceDoc | undefined {
  const list = report.sources.filter((s) => s.kind === kind);
  return list.find((s) => s.status !== "listed") ?? list[0];
}

function statusRows(report: ResearchReport, cached: boolean): StatusRow[] {
  const transcripts = report.sources.filter((s) => s.kind === "transcript");
  const read = transcripts.filter((s) => s.status === "used").length;
  const failed = transcripts.filter((s) => s.status === "failed").length;
  const latest = latestCall(report);
  const annual = docOf(report, "annual_report");
  const results = docOf(report, "results");
  const deck = docOf(report, "presentation");
  // Some companies hold one analyst call a year; a stale "latest" call changes what guidance means.
  const stale = latest != null && latest.ageDays > 200;
  // A precomputed or demo report is not live, whatever its sources were when it was built.
  const inherited: DisplayProvenance | null = report.provenance === "live" ? (cached ? "cache" : null) : report.provenance;
  const statements = report.statementsSource;
  const priceSource = report.price?.source;
  const notLive = (mode?: string) => (mode && mode !== "live" && mode !== "cache" ? ` · ${mode}` : "");
  const demoNote = report.provenance === "demo" ? " in demo mode" : "";
  const docRow = (label: string, d: SourceDoc | undefined, missing: StatusRow["provenance"]): StatusRow => ({
    label,
    value: d
      ? d.status === "used"
        ? `${d.period ?? ""} · read`
        : d.status === "failed"
          ? `${d.period ?? ""} · could not be read`
          : `${d.period ?? ""} · linked, not read${demoNote}`
      : "None found",
    provenance: !d ? missing : d.status === "failed" ? "error" : (inherited ?? "live"),
  });
  return [
    {
      label: "Annual report",
      value: annual
        ? annual.status === "used"
          ? `${annual.period ?? ""} · ${annual.coverage?.truncated ? `${annual.coverage.pagesRead} of ${annual.coverage.totalPages}` : (annual.coverage?.totalPages ?? annual.pages ?? "all")} pages read`
          : annual.status === "failed"
            ? `${annual.period ?? ""} · could not be read`
            : `${annual.period ?? ""} · linked, not read${demoNote}`
        : "None found — add one under Sources",
      provenance: !annual || annual.status === "failed" ? "error" : (inherited ?? "live"),
    },
    {
      label: "Transcripts",
      value: transcripts.length
        ? report.guidance.status === "skipped"
          ? `${transcripts.length} linked, not read in demo mode`
          : `${read} of ${transcripts.length} read${failed ? ` · ${failed} failed` : ""}${latest ? ` · latest call ${latest.label}${stale ? " — more than six months old" : ""}` : ""}`
        : "None linked",
      provenance: transcripts.length === 0 || (read === 0 && report.guidance.status !== "skipped") ? "error" : (inherited ?? (failed || stale ? "stale" : "live")),
    },
    docRow("Results filing", results, "none"),
    docRow("Presentation", deck, "none"),
    {
      label: "Statements",
      value: `screener.in · ${report.basis} · ${report.units.replace(" ", " ")}${notLive(statements?.mode)}`,
      provenance: inherited ?? statements?.mode ?? "live",
    },
    {
      label: "Prices",
      value: report.price
        ? `${priceSource?.label.replace(/\s*\(.*\)$/, "") ?? "Yahoo Finance"}${report.exchange === "BSE" ? " · BSE listing" : ""} · close ${shortDate(report.price.date)}${priceSource?.adjustment === "as-traded" ? " · as traded" : ""}${notLive(priceSource?.mode)}`
        : "Unavailable",
      provenance: report.price ? (inherited ?? priceSource?.mode ?? "live") : "error",
    },
    {
      label: "Built",
      value: `${report.provenance === "snapshot" ? "Precomputed snapshot" : report.provenance === "demo" ? "Demo dataset" : "Live"} · ${dateTime(report.generatedAt)}${cached ? " · served from FINN's cache" : ""}`,
      provenance: inherited ?? "live",
    },
    {
      label: "Synthesis",
      value: report.thesis ? `On · ${report.thesis.model}` : report.llm.enabled ? "Failed — see Sources" : "Off — no LLM key; no view needs one",
      provenance: report.thesis ? "live" : report.llm.enabled ? "error" : "none",
    },
  ];
}

function StatusDot({ provenance }: { provenance: StatusRow["provenance"] }) {
  return provenance === "none" ? <span className="inline-block h-2 w-2 shrink-0 rounded-full border border-line-strong" aria-hidden="true" /> : <ProvenanceDot provenance={provenance} />;
}

/** What FINN read, in one sentence; a precomputed or demo report says when that was true. */
function CoverageLine({ report }: { report: ResearchReport }) {
  if (!report.coverage) return null;
  return (
    <>
      {report.provenance !== "live" && <span className="text-muted">When this {report.provenance === "demo" ? "demo" : "precomputed"} report was built: </span>}
      {report.coverage}
    </>
  );
}

/**
 * Which sources this report actually rests on. On a phone it folds to the one-sentence coverage
 * line (which names anything that failed); the rows open on tap. On a desktop it sits open in
 * the sidebar.
 */
function DataStatus({ report, collapsible, onSources }: { report: ResearchReport; collapsible?: boolean; onSources: () => void }) {
  const headingId = useId();
  const cached = useCachedAge(report);
  const rows = (
    <dl className="space-y-2 text-[14px] leading-5">
      {statusRows(report, cached).map((r) => (
        <div key={r.label} className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-2.5">
          <dt className="text-muted">{r.label}</dt>
          <dd className="flex gap-2">
            <span className="flex h-5 items-center">
              <StatusDot provenance={r.provenance} />
            </span>
            <span className="min-w-0">{r.value}</span>
          </dd>
        </div>
      ))}
      <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-2.5">
        <dt className="text-muted">Not covered</dt>
        <dd className="flex gap-2 text-muted">
          <span className="flex h-5 items-center">
            <StatusDot provenance="none" />
          </span>
          <span className="min-w-0">Segment revenue mix, annual-report pages after 300, scanned (image-only) PDFs</span>
        </dd>
      </div>
      <div className="pt-1">
        <button type="button" onClick={onSources} className="-my-1.5 inline-flex items-center gap-0.5 py-1.5 text-[13.5px] font-medium text-accent hover:underline">
          Every document, with links <ChevronIcon size={14} />
        </button>
      </div>
    </dl>
  );
  if (collapsible) {
    return (
      <details className="group rounded-xl border border-line bg-surface">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="t-kicker block">Data status</span>
            <span className="mt-1 block text-[14px] leading-snug text-ink">
              <CoverageLine report={report} />
            </span>
          </span>
          <ChevronDownIcon size={18} className="mt-0.5 shrink-0 text-muted transition-transform group-open:rotate-180" />
          <span className="sr-only">Show each source&apos;s status</span>
        </summary>
        <div className="border-t border-line px-4 pb-3.5 pt-3">{rows}</div>
      </details>
    );
  }
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <h2 id={headingId} className="t-kicker">
        Data status
      </h2>
      {report.coverage && (
        <p className="mt-1.5 border-b border-line pb-3 text-[14px] leading-snug">
          <CoverageLine report={report} />
        </p>
      )}
      <div className="mt-3">{rows}</div>
    </section>
  );
}

/**
 * The report's views as one row of links, at every width: pinned under the header, scrolling
 * sideways on a phone (a fade marks that more follow). Each is a real ?view= link, so it can be
 * opened in a new tab or shared; a plain click switches in place.
 */
function ViewNav({ view, onView }: { view: ResearchView; onView: (v: ResearchView) => void }) {
  const row = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    // Keep the selected chip visible in the scrolling row; a deep link can open on the last view.
    // Horizontal only: scrollIntoView would also move the page when the row is below the fold.
    const el = row.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active) return;
    const box = el.getBoundingClientRect();
    const chip = active.getBoundingClientRect();
    // 48px clears the fade that marks more views to the right.
    if (chip.left < box.left) el.scrollBy({ left: chip.left - box.left - 16 });
    else if (chip.right > box.right - 48) el.scrollBy({ left: chip.right - box.right + 48 });
  }, [view]);

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const update = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    const id = requestAnimationFrame(update);
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(id);
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const go = (e: MouseEvent<HTMLAnchorElement>, id: ResearchView) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onView(id);
  };

  return (
    <nav aria-label="Report views" className="sticky top-14 z-20 -mx-4 mt-5 border-b border-line bg-bg/92 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-bg/80 lg:mx-0 lg:px-0">
      <div className="relative">
        <ul ref={row} className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {VIEWS.map(([id, label]) => (
            <li key={id} className="shrink-0">
              <a
                href={`?view=${id}`}
                aria-current={view === id ? "page" : undefined}
                onClick={(e) => go(e, id)}
                className={cx("flex min-h-10 items-center whitespace-nowrap rounded-md px-3 text-[13.5px] font-medium", view === id ? "bg-ink text-bg" : "bg-surface-2 text-muted hover:text-ink")}
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
        {more && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-linear-to-l from-bg to-transparent" />}
      </div>
    </nav>
  );
}

function Header({ report, p }: { report: ResearchReport; p: ResearchScreenProps }) {
  const ratios = report.topRatios.filter((r) => /market cap|stock p\/e|roce|roe|dividend yield/i.test(r.name));
  const demo = report.provenance === "demo";
  const cached = useCachedAge(report);
  return (
    <header>
      <p className="t-kicker">
        <span className="num">{report.symbol}</span> · {report.exchange === "BSE" ? "BSE prices" : "NSE"} · {report.basis === "consolidated" ? "Consolidated" : "Standalone"}
        {report.isLender && " · Lender"}
      </p>
      <div className="mt-2 flex items-start justify-between gap-4">
        <h1 className="t-display min-w-0 lg:text-[38px]">{report.name}</h1>
        {report.price && <Sparkline values={report.price.spark} width={104} height={40} className="mt-1 shrink-0" label={`${report.symbol} price, last ${report.price.spark.length} sessions`} />}
      </div>
      {report.price ? (
        <p className="mt-2 text-[15px]">
          <span className="num font-semibold">₹{formatCrore(report.price.close, 2)}</span> <Pct value={report.price.changePct} className="ml-1" />
          <span className="t-meta block">
            Close {shortDate(report.price.date)}
            {report.price.low52 != null && report.price.high52 != null && ` · 52-week range ₹${formatCrore(report.price.low52)}–₹${formatCrore(report.price.high52)}`}
          </span>
        </p>
      ) : (
        <p className="t-meta mt-2">Price unavailable — Yahoo Finance did not respond.</p>
      )}
      {ratios.length > 0 && (
        <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 border-y border-line py-3 text-[14px] sm:grid-cols-5">
          {ratios.map((r) => (
            <div key={r.name}>
              <dt className="t-meta">{r.name.replace("Stock P/E", "P/E")}</dt>
              {/* screener.in's display strings, tidied ("₹ 22,522 Cr." → "₹22,522 cr"); the numbers are untouched. */}
              <dd className="num mt-0.5 font-medium">{r.value.replace(/\s+/g, " ").replace(" Cr.", " cr").replace("₹ ", "₹").replace(/ %$/, "%")}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ProvenanceBadge provenance={p.sampleNotice ? "sample" : cached ? "cache" : report.provenance} label={cached && !p.sampleNotice ? "Cached · built" : undefined} asOf={report.generatedAt} withTime />
        <div className="flex gap-2">
          <Button size="sm" variant={p.inPortfolio ? "ghost" : "primary"} onClick={p.onToggleWatch} aria-pressed={p.inPortfolio}>
            {p.inPortfolio ? (
              <>
                <CheckIcon size={14} /> In your inbox
              </>
            ) : (
              "Watch in inbox"
            )}
          </Button>
          <Button
            size="sm"
            onClick={p.onRebuild}
            disabled={p.loading || demo}
            aria-busy={p.loading}
            title={demo ? "Demo data replays the committed capture; rebuilding needs live data" : undefined}
          >
            <RefreshIcon size={14} className={p.loading ? "animate-spin" : undefined} />
            {p.loading ? "Rebuilding" : "Rebuild live"}
          </Button>
        </div>
      </div>
      {demo && <p className="t-meta mt-2">Rebuilding needs live data: demo data replays FINN&apos;s committed capture. Switch with the Demo data badge at the top.</p>}
    </header>
  );
}

/** Errors no retry can fix: the symbol is not covered. These lead back to search instead. */
const NOT_COVERED = /not an NSE-listed|no page on screener|not in the demo dataset|not covered by research/i;

export function ResearchScreen(p: ResearchScreenProps) {
  const { report } = p;
  const sources: SourceMap = useMemo(() => new Map((report?.sources ?? []).map((s) => [s.id, s])), [report]);
  const toSources = () => p.onView("sources");
  const demo = report?.provenance === "demo";
  const notCovered = p.error != null && NOT_COVERED.test(p.error);

  return (
    <PageFrame>
      <Link href="/research" className="-ml-1 inline-flex min-h-10 items-center gap-0.5 text-[14px] text-muted hover:text-ink">
        <ChevronIcon size={16} className="rotate-180" /> All research
      </Link>

      {p.sampleNotice && (
        <div className="mt-3">
          <StatusNotice tone="sample" title="Sample report">
            {p.sampleNotice}
          </StatusNotice>
        </div>
      )}

      {p.error && (
        <div className="mt-4 max-w-2xl">
          <StatusNotice
            tone="error"
            title={`Couldn't research ${p.symbol}`}
            action={
              <div className="flex flex-wrap gap-2">
                {notCovered ? (
                  <>
                    {p.onUseLive && /not in the demo dataset/i.test(p.error ?? "") && (
                      <Button variant="primary" onClick={p.onUseLive}>
                        Switch to live data
                      </Button>
                    )}
                    <ButtonLink href="/research" variant={p.onUseLive && /not in the demo dataset/i.test(p.error ?? "") ? "ghost" : "primary"}>
                      Search for another company
                    </ButtonLink>
                  </>
                ) : (
                  <>
                    <Button onClick={p.onRetry}>Try again</Button>
                    {p.onUseDemo ? (
                      <Button variant="ghost" onClick={p.onUseDemo}>
                        Use demo data instead
                      </Button>
                    ) : (
                      <ButtonLink href="/research" variant="ghost">
                        Choose another company
                      </ButtonLink>
                    )}
                  </>
                )}
              </div>
            }
          >
            {p.error}
          </StatusNotice>
        </div>
      )}

      {!report && !p.error && (
        <div className="mt-4 max-w-2xl" aria-busy="true">
          <p className="t-kicker num">{p.symbol} · NSE</p>
          <Skeleton className="mt-3 h-8 w-64" />
          <Skeleton className="mt-3 h-4 w-48" />
          <p className="mt-6 text-[15px] text-muted">
            Reading primary sources: the latest annual report, the last four earnings-call transcripts, the latest results filing and presentation, plus standardised statements and end-of-day prices.
          </p>
          <p className="t-meta mt-2">A first report usually takes 15–40 seconds. FINN keeps it for six hours, so the next visit opens at once.</p>
          <div className="mt-5">
            <Progress steps={p.steps} />
          </div>
        </div>
      )}

      {report && (
        <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-12">
          <div className="min-w-0">
            <Header report={report} p={p} />
            {p.loading && p.steps.length > 0 && (
              <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3.5">
                <p className="t-kicker mb-2.5">Rebuilding from live sources</p>
                <Progress steps={p.steps} />
              </div>
            )}
            <div className="mt-5 lg:hidden">
              <DataStatus report={report} collapsible onSources={toSources} />
            </div>
            {/* A direct child of the report column, so it can stay pinned for the whole report. */}
            <ViewNav view={p.view} onView={p.onView} />

            <div className="mt-6">
              {p.view === "business" && (
                <ReportSection id="business" title="Business snapshot" hint="What the company's own documents say it does — verbatim, with pages." legend>
                  <BusinessView business={report.business} sources={sources} onAddSource={toSources} />
                </ReportSection>
              )}

              {p.view === "financials" && (
                <ReportSection
                  id="financials"
                  title="Financial snapshot & trajectory"
                  hint={`${report.units}, ${report.basis}, fiscal years ending March. Figures are traced to the annual report or results filing where FINN could find them on a page.`}
                  legend
                >
                  <ClaimList claims={[...report.headline, ...report.trajectory.claims]} sources={sources} />
                  <BarChart caption="Annual revenue (₹ crore)" labels={report.trajectory.years} series={[{ name: "Revenue", values: report.trajectory.revenue, color: "var(--series-1)" }]} />
                  <SeriesTable
                    caption="Annual figures (₹ crore; margin in %)"
                    labels={report.trajectory.years}
                    rows={[
                      { name: "Revenue", values: report.trajectory.revenue, format: crore },
                      { name: report.isLender ? "NII" : "EBITDA", values: report.trajectory.ebitda, format: crore },
                      ...(report.isLender ? [] : [{ name: "EBITDA margin", values: report.trajectory.margin, format: pct1 }]),
                      { name: "PAT", values: report.trajectory.pat, format: crore },
                    ]}
                  />
                  {report.quarters.labels.length > 0 && (
                    <>
                      <BarChart
                        caption="Quarterly revenue growth, year on year (%)"
                        labels={report.quarters.labels.map(quarterLines)}
                        series={[{ name: "Revenue YoY", values: report.quarters.revenueYoY, color: "var(--series-1)" }]}
                        format={signed}
                      />
                      <SeriesTable
                        caption="Last eight quarters (₹ crore; growth and margin in %)"
                        labels={report.quarters.labels}
                        rows={[
                          { name: "Revenue", values: report.quarters.revenue, format: crore },
                          { name: "YoY", values: report.quarters.revenueYoY, format: signed },
                          ...(report.isLender ? [] : [{ name: "EBITDA margin", values: report.quarters.margin, format: pct1 }]),
                          { name: "PAT", values: report.quarters.pat, format: crore },
                          { name: "PAT YoY", values: report.quarters.patYoY, format: signed },
                        ]}
                      />
                      <p className="t-meta mt-2">Fiscal quarters: Q1 is April–June; FY27 ends March 2027.</p>
                    </>
                  )}
                </ReportSection>
              )}

              {p.view === "balance" && (
                <div className="space-y-10">
                  <ReportSection id="balance" title="Balance sheet & working capital" hint={`${report.units}, ${report.basis}. Leverage, and how much cash day-to-day operations tie up.`} legend>
                    <ClaimList claims={[...report.balanceSheet.claims, ...report.workingCapital.claims]} sources={sources} />
                    <SeriesTable
                      caption="Balance sheet (₹ crore)"
                      labels={report.balanceSheet.years}
                      rows={[
                        { name: "Borrowings", values: report.balanceSheet.borrowings, format: crore },
                        { name: "Equity", values: report.balanceSheet.equity, format: crore },
                        ...(report.isLender ? [] : [{ name: "Debt / equity", values: report.balanceSheet.debtToEquity, format: (v: number) => v.toFixed(2) }]),
                      ]}
                    />
                    {!report.isLender && report.workingCapital.ccc.some((v) => v != null) && (
                      <SeriesTable
                        caption="Working-capital cycle (days)"
                        labels={report.workingCapital.years}
                        rows={[
                          { name: "Debtor days", values: report.workingCapital.debtorDays, format: (v) => String(v) },
                          { name: "Inventory days", values: report.workingCapital.inventoryDays, format: (v) => String(v) },
                          { name: "Cash conversion cycle", values: report.workingCapital.ccc, format: (v) => String(v) },
                        ]}
                      />
                    )}
                  </ReportSection>
                  <ReportSection id="cash" title="Cash quality" hint="Do reported profits turn into cash, and how much goes back into the business as capex?" divider>
                    <ClaimList claims={report.cash.claims} sources={sources} />
                    {!report.isLender && (
                      <>
                        <BarChart
                          caption="Operating cash flow vs PAT (₹ crore)"
                          labels={report.cash.years}
                          series={[
                            { name: "Cash from operations", values: report.cash.cfo, color: "var(--series-1)" },
                            { name: "PAT", values: report.cash.pat, color: "var(--series-2)" },
                          ]}
                        />
                        <SeriesTable
                          caption="Cash flow (₹ crore)"
                          labels={report.cash.years}
                          rows={[
                            { name: "Operating cash flow", values: report.cash.cfo, format: crore },
                            ...(report.cash.capex ? [{ name: "Capex (CFO − FCF)", values: report.cash.capex, format: crore }] : []),
                            { name: "Free cash flow", values: report.cash.fcf, format: crore },
                            { name: "PAT", values: report.cash.pat, format: crore },
                          ]}
                        />
                      </>
                    )}
                  </ReportSection>
                </div>
              )}

              {p.view === "narrative" && (
                <ReportSection id="narrative" title="Narrative vs numbers" hint="What management promised and said on its calls, against what the company later reported." legend>
                  <NarrativeView report={report} sources={sources} rule={ASSESSMENT_RULE} onAddSource={toSources} />
                </ReportSection>
              )}

              {p.view === "case" && (
                <ReportSection id="case" title="Bull vs bear" hint="The evidence each way, from the cited facts in this report. Not a recommendation." legend>
                  <CaseView report={report} sources={sources}>
                    {report.thesis && (
                      <div className="border-t border-line pt-6">
                        <h3 className="t-kicker mb-2">Model synthesis ({report.thesis.model})</h3>
                        <ThesisBlock report={report} sources={sources} />
                      </div>
                    )}
                  </CaseView>
                </ReportSection>
              )}

              {p.view === "sources" && (
                <ReportSection id="sources" title="Sources" hint="Primary documents are the evidence. No news, broker notes or model knowledge.">
                  <SourcesList report={report} />
                  <div className="mt-5">
                    <AddSourceForm extras={p.extras} onAdd={p.onAddSource} onRemove={p.onRemoveSource} disabled={demo || p.loading} />
                  </div>
                  {report.warnings.length > 0 && (
                    <div className="mt-4">
                      <StatusNotice tone="warn" title="Notes from this run">
                        <ul className="list-disc space-y-0.5 pl-4">
                          {report.warnings.map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      </StatusNotice>
                    </div>
                  )}
                  <p className="t-meta mt-4">
                    {report.llm.used
                      ? `LLM calls: ${report.llm.calls} (${report.llm.fastModel} for structuring, ${report.llm.reasoningModel} for synthesis).`
                      : report.llm.enabled
                        ? "LLM configured but not needed for this report."
                        : "No LLM was used: every number, verdict, excerpt and case point is computed or extracted deterministically."}
                  </p>
                </ReportSection>
              )}
            </div>
          </div>

          <aside aria-label="Report status" className="hidden lg:block">
            <DataStatus report={report} onSources={toSources} />
          </aside>
        </div>
      )}
    </PageFrame>
  );
}
