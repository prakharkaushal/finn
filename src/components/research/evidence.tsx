"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { formatCroreInr } from "@/lib/domain/numbers";
import { dateTime } from "@/lib/format";
import { METRIC_LABEL, rangeLabel } from "@/lib/research/guidance";
import type { ExtraSource } from "@/lib/research/discover";
import type { Assessment, BusinessSection, CasePoint, Citation, Claim, ClaimCheck, Evidence, GuidanceStatement, ResearchReport, SourceDoc } from "@/lib/research/types";
import { FileIcon } from "@/components/icons";
import { SECTION_NAME, type SourceMap } from "@/components/research/sections";
import { Button, cx, EmptyState, SourceLink, StatusNotice, Tag, type Tone } from "@/components/ui";

/**
 * Evidence-first building blocks for Pull research. Two visual registers, never mixed:
 * "Source says" — a verbatim excerpt with its page — and FINN's interpretation — a computed or
 * rule-based statement that cites the evidence. Every claim links to the page it rests on, or
 * says plainly that its citation is document-level.
 */

const CHECK_NAME: Record<ClaimCheck["metric"], string> = { revenue_growth: "Revenue growth (YoY)", pat_growth: "PAT growth (YoY)", ebitda_margin: "EBITDA margin" };

export function citeLabel(doc: SourceDoc | undefined, c: Citation): string {
  if (!doc) return "source";
  const where = c.page ? ` p. ${c.page}` : c.level === "document" ? " (whole document)" : "";
  switch (doc.kind) {
    case "annual_report":
      return `Annual report${doc.period ? ` ${doc.period}` : ""}${where}`;
    case "transcript":
      return `${doc.period ? `${doc.period} call` : "Call transcript"}${where}${c.speaker ? ` · ${c.speaker}` : ""}`;
    case "results":
      return `Results filing${doc.period ? ` ${doc.period}` : ""}${where}`;
    case "presentation":
      return `Investor presentation${where}`;
    case "screener":
      return `screener · ${SECTION_NAME[c.section ?? ""] ?? c.section ?? "statements"}`;
    default:
      return `${doc.title}${where}`;
  }
}

function hrefFor(doc: SourceDoc | undefined, c: Citation): string | null {
  if (!doc) return null;
  if (c.page) return `${doc.url}#page=${c.page}`;
  if (doc.kind === "screener" && c.section) return `${doc.url}#${c.section}`;
  return doc.url;
}

/** One citation: page-level links straight to the page; secondary and document-level ones say so. */
export function Cite({ c, sources }: { c: Citation; sources: SourceMap }) {
  const doc = sources.get(c.sourceId);
  const href = hrefFor(doc, c);
  const secondary = doc?.primary === false;
  const label = citeLabel(doc, c);
  if (!href) return <span className="t-meta">{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={secondary ? "Secondary source: a standardised table compiled from filings" : c.level === "document" ? "Document-level: FINN did not locate this on a page" : undefined}
      className={cx("inline-flex min-h-7 items-center gap-1 whitespace-nowrap text-[12.5px] hover:underline", secondary ? "text-muted" : "text-accent")}
    >
      <FileIcon size={12} />
      {label}
      {secondary && <span className="text-faint">· secondary</span>}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** A verbatim excerpt from a primary document. */
export function SourceSays({ excerpt, cite, sources }: { excerpt: string; cite: Citation; sources: SourceMap }) {
  return (
    <figure className="mt-2 rounded-lg bg-surface-2/70 px-3 py-2.5">
      <figcaption className="t-kicker mb-1 text-faint">Source says</figcaption>
      <blockquote className="font-serif text-[15px] leading-relaxed text-ink">“{excerpt}”</blockquote>
      {cite.unit && <p className="t-meta mt-1">Figures on this page are in {cite.unit}; FINN states them in ₹ crore.</p>}
      <div className="mt-1">
        <Cite c={cite} sources={sources} />
      </div>
    </figure>
  );
}

function evidenceCite(e: Evidence): Citation {
  return { sourceId: e.sourceId, page: e.page, level: "page", ...(e.section ? { section: e.section } : {}), ...(e.speaker ? { speaker: e.speaker } : {}) };
}

/** Favourable / unfavourable carried by a glyph as well as colour; a neutral fact is a plain bullet. */
const TONE_MARK: Record<Claim["tone"], { glyph: ReactNode; className: string; title: string }> = {
  positive: { glyph: "+", className: "bg-up-soft text-up", title: "Favourable" },
  negative: { glyph: "−", className: "bg-down-soft text-down", title: "Unfavourable" },
  neutral: { glyph: <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />, className: "", title: "Neutral" },
};

/** FINN's computed statements, each followed by the page evidence it found and its other citations. */
export function ClaimList({ claims, sources }: { claims: Claim[]; sources: SourceMap }) {
  if (!claims.length) return <p className="text-[14px] text-muted">Not available in the retrieved statements.</p>;
  return (
    <ul className="space-y-4">
      {claims.map((c) => {
        const located = c.citations.filter((x) => x.level === "page" && x.excerpt);
        const others = c.citations.filter((x) => !(x.level === "page" && x.excerpt));
        const mark = TONE_MARK[c.tone];
        return (
          <li key={c.id} id={`claim-${c.id}`} className="flex gap-3">
            <span
              aria-hidden="true"
              title={mark.title}
              className={cx("mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-[14px] font-semibold leading-none", mark.className)}
            >
              {mark.glyph}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] leading-relaxed">
                <span className="sr-only">{c.tone === "positive" ? "Favourable. " : c.tone === "negative" ? "Unfavourable. " : ""}FINN: </span>
                {c.text}
              </p>
              {located.map((x) => (
                <SourceSays key={`${x.sourceId}-${x.page}`} excerpt={x.excerpt!} cite={x} sources={sources} />
              ))}
              <p className="mt-1 flex flex-wrap gap-x-3">
                {others.map((x, i) => (
                  <Cite key={`${x.sourceId}-${x.section ?? ""}-${i}`} c={x} sources={sources} />
                ))}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---- Business snapshot ---------------------------------------------------------------------------

export function BusinessView({ business, sources, onAddSource }: { business: BusinessSection | undefined; sources: SourceMap; onAddSource: () => void }) {
  if (!business) {
    return <EmptyState title="Not in this report">This report was built before FINN read annual reports. Rebuild it to see the company&apos;s own description.</EmptyState>;
  }
  const empty = business.status !== "ok";
  return (
    <div className="space-y-6">
      {empty && (
        <StatusNotice tone={business.status === "skipped" ? "info" : "warn"} title={business.status === "skipped" ? "Not read in demo mode" : "No annual report read"} action={business.status === "skipped" ? undefined : <Button size="sm" onClick={onAddSource}>Add an annual report</Button>}>
          {business.note}
        </StatusNotice>
      )}
      {business.overview.length > 0 && (
        <section>
          <h3 className="t-kicker mb-1">What the annual report says the company does</h3>
          {business.overview.map((e) => (
            <SourceSays key={`${e.sourceId}-${e.page}`} excerpt={e.excerpt} cite={evidenceCite(e)} sources={sources} />
          ))}
        </section>
      )}
      {business.status === "ok" && (
        <section>
          <h3 className="t-kicker mb-1">Reporting segments</h3>
          {business.segments ? (
            <>
              <p className="text-[15px]">
                <span className="sr-only">FINN: </span>
                {business.segments.single
                  ? "The annual report states the company has a single reportable segment."
                  : "The annual report's segment disclosure, in the company's words (FINN does not re-type segment names):"}
              </p>
              <SourceSays excerpt={business.segments.evidence.excerpt} cite={evidenceCite(business.segments.evidence)} sources={sources} />
              <p className="t-meta mt-1.5">Segment revenue mix is not computed: annual-report segment tables do not survive PDF text extraction reliably enough to do arithmetic on. Read it on the cited page.</p>
            </>
          ) : (
            <p className="text-[14px] text-muted">Not available in the retrieved source: FINN found no sentence naming the reporting segments.</p>
          )}
        </section>
      )}
      {business.management.length > 0 && (
        <section>
          <h3 className="t-kicker mb-1">How management described it on the latest call</h3>
          {business.management.map((e) => (
            <SourceSays key={`${e.sourceId}-${e.page}`} excerpt={e.excerpt} cite={evidenceCite(e)} sources={sources} />
          ))}
        </section>
      )}
      <p className="t-meta">Excerpts are verbatim, chosen by rules (self-description patterns, then keyword search) over this company&apos;s own documents. No model wrote or summarised them.</p>
    </div>
  );
}

// ---- Narrative vs numbers ------------------------------------------------------------------------

const ASSESSMENT_TONE: Record<Assessment, Tone> = { met: "up", "partially met": "warn", missed: "down", "not comparable / insufficient evidence": "neutral" };
const ASSESSMENT_LABEL: Record<Assessment, string> = { met: "Met", "partially met": "Partially met", missed: "Missed", "not comparable / insufficient evidence": "Not comparable" };

function quoteCite(s: { sourceId: string; page: number; speaker?: string }): Citation {
  return { sourceId: s.sourceId, page: s.page, level: "page", ...(s.speaker ? { speaker: s.speaker } : {}) };
}

/** The standardised table a reported figure was read from, so it can be opened like any citation. */
function basisCite(basis: string | undefined, sources: SourceMap): Citation | null {
  if (!basis?.startsWith("screener.in")) return null;
  const doc = [...sources.values()].find((d) => d.kind === "screener");
  if (!doc) return null;
  return { sourceId: doc.id, section: /quarterly/i.test(basis) ? "quarters" : "profit-loss", level: "section" };
}

function Reported({ s, sources }: { s: GuidanceStatement; sources: SourceMap }) {
  const v = s.verdict;
  if (!v || v.actual == null) return <span className="text-muted">No reported figure yet</span>;
  const value = s.unit === "INR_cr" ? formatCroreInr(v.actual) : s.metric?.endsWith("margin") ? `${v.actual.toFixed(1)}%` : `${v.actual >= 0 ? "+" : "−"}${Math.abs(v.actual).toFixed(1)}%`;
  const cite = basisCite(v.basis, sources);
  return (
    <>
      {v.actualLabel ?? "Reported"}: <span className="num font-medium">{value}</span>
      {cite && (
        <span className="block">
          <Cite c={cite} sources={sources} />
        </span>
      )}
    </>
  );
}

function PromiseRow({ s, sources }: { s: GuidanceStatement; sources: SourceMap }) {
  const a = s.assessment ?? "not comparable / insufficient evidence";
  // Short bases ("screener.in annual P&L") are the link under Reported; longer ones explain a definition.
  const definition = s.verdict?.basis?.includes(":") ? s.verdict.basis : null;
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <p className="t-kicker">{s.period?.label ?? "Period not stated"}</p>
        <Tag tone={ASSESSMENT_TONE[a]}>{ASSESSMENT_LABEL[a]}</Tag>
      </div>
      <p className="mt-1 text-[15px] font-semibold">
        {s.metric ? METRIC_LABEL[s.metric] : "Statement"} <span className="num whitespace-nowrap">{rangeLabel(s)}</span>
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-2 text-[14px] sm:grid-cols-[120px_1fr]">
        <dt className="t-meta">Source says</dt>
        <dd>
          <blockquote className="font-serif text-[15px] leading-relaxed">“{s.quote}”</blockquote>
          <Cite c={quoteCite(s)} sources={sources} />
          {s.voice === "analyst" && <p className="mt-1 text-[13px] text-warn">An analyst restating guidance — not management&apos;s own words.</p>}
          {s.period?.inferred && <p className="t-meta">Period inferred from the call date.</p>}
        </dd>
        <dt className="t-meta">Reported</dt>
        <dd className="text-ink">
          <Reported s={s} sources={sources} />
        </dd>
        <dt className="t-meta">FINN&apos;s assessment</dt>
        <dd>
          {s.assessmentNote ?? s.verdict?.basis}
          {definition && s.assessmentNote && s.assessment !== "not comparable / insufficient evidence" && <span className="t-meta block">{definition}</span>}
        </dd>
      </dl>
    </li>
  );
}

export function NarrativeView({ report, sources, rule, onAddSource }: { report: ResearchReport; sources: SourceMap; rule: string; onAddSource: () => void }) {
  const g = report.guidance;
  const scored = g.statements.filter((s) => s.metric && s.verdict);
  const remarks = g.statements.filter((s) => !s.metric);
  const order: Assessment[] = ["missed", "partially met", "met", "not comparable / insufficient evidence"];
  const sorted = [...scored].sort((a, b) => order.indexOf(a.assessment ?? "not comparable / insufficient evidence") - order.indexOf(b.assessment ?? "not comparable / insufficient evidence"));
  const counts = order.map((a) => [a, scored.filter((s) => (s.assessment ?? "not comparable / insufficient evidence") === a).length] as const).filter(([, n]) => n > 0);
  const checks = report.checks ?? [];
  if (g.status !== "ok") {
    return (
      <EmptyState
        title={g.status === "skipped" ? "Transcripts not read in demo mode" : g.status === "no_transcripts" ? "No transcripts to check" : "Transcripts couldn't be read"}
        action={g.status === "skipped" ? undefined : <Button onClick={onAddSource}>Add a transcript</Button>}
      >
        {g.note ?? "Transcripts are linked but none could be read (scanned images or unreachable links). See Sources for each one."}
      </EmptyState>
    );
  }
  return (
    <div className="space-y-8">
      <section aria-labelledby="promises-heading">
        <h3 id="promises-heading" className="t-kicker">Promises vs what was reported</h3>
        <p className="mt-1 text-[14px] text-muted">
          Quantified guidance from {g.transcriptsRead} call transcript{g.transcriptsRead === 1 ? "" : "s"}, each quote verbatim with its page. Vague commentary is not treated as a promise.
        </p>
        {counts.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-1.5">
            {counts.map(([a, n]) => (
              <Tag key={a} tone={ASSESSMENT_TONE[a]}>
                {n} {ASSESSMENT_LABEL[a].toLowerCase()}
              </Tag>
            ))}
          </p>
        )}
        {sorted.length ? (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {sorted.map((s) => (
              <PromiseRow key={s.id} s={s} sources={sources} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[14px] text-muted">No quantified promises in the transcripts read — management&apos;s forward-looking remarks were qualitative.</p>
        )}
        <p className="t-meta mt-2">{rule}</p>
        {remarks.length > 0 && (
          <details className="mt-3">
            <summary className="min-h-9 cursor-pointer py-2 text-[14px] text-accent">
              {remarks.length} qualitative forward-looking remark{remarks.length === 1 ? "" : "s"}, kept as quotes and not scored
            </summary>
            <ul className="mt-1 divide-y divide-line rounded-xl border border-line bg-surface">
              {remarks.map((s) => (
                <li key={s.id} className="px-4 py-3 sm:px-5">
                  <blockquote className="font-serif text-[15px] leading-relaxed">“{s.quote}”</blockquote>
                  <Cite c={quoteCite(s)} sources={sources} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section aria-labelledby="checks-heading">
        <h3 id="checks-heading" className="t-kicker">Numbers management stated vs reported</h3>
        <p className="mt-1 text-[14px] text-muted">Figures said on a call about the quarter just finished, checked against the reported quarter. A gap is flagged, not resolved.</p>
        {checks.length ? (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {checks.map((c) => (
              <li key={c.id} className="px-4 py-3.5 sm:px-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[14px] font-semibold">
                    {CHECK_NAME[c.metric]} · {c.quarter}
                  </p>
                  <Tag tone={c.status === "conflict" ? "down" : c.status === "consistent" ? "up" : "neutral"}>{c.status === "conflict" ? "Conflict" : c.status === "consistent" ? "Consistent" : "Not comparable"}</Tag>
                </div>
                <blockquote className="mt-1.5 font-serif text-[15px] leading-relaxed">“{c.quote}”</blockquote>
                <Cite c={quoteCite(c)} sources={sources} />
                <p className="mt-1 text-[14px]">
                  <span className="text-muted">FINN: </span>
                  {c.note}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[14px] text-muted">No checkable figures: management did not state a quarter&apos;s year-on-year growth or EBITDA margin in a way FINN could match to the reported quarter.</p>
        )}
      </section>

      {g.revisions.length > 0 && (
        <section>
          <h3 className="t-kicker">Guidance changes across calls</h3>
          <ul className="mt-2 space-y-1.5 text-[14px]">
            {g.revisions.map((r, i) => (
              <li key={i}>
                <span className={cx("font-medium", r.direction === "raised" ? "text-up" : r.direction === "cut" ? "text-down" : "text-muted")}>{r.direction === "raised" ? "Raised" : r.direction === "cut" ? "Cut" : "Held"}</span> {r.period} {METRIC_LABEL[r.metric]} {r.from === r.to ? r.to : `${r.from} → ${r.to}`}{" "}
                <span className="t-meta">
                  {r.fromCall} → {r.toCall}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---- Bull vs bear --------------------------------------------------------------------------------

function Point({ p, sources, side }: { p: CasePoint; sources: SourceMap; side: "bull" | "bear" }) {
  return (
    <li className="py-3.5">
      <p className="t-kicker">{p.theme}</p>
      <p className="mt-1 text-[15px] leading-relaxed">
        <span className="sr-only">FINN: </span>
        {p.text}
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3">
        {p.citations.slice(0, 4).map((c, i) => (
          <Cite key={i} c={c} sources={sources} />
        ))}
      </p>
      <div className="mt-2 border-l-2 border-line-strong pl-3">
        <p className="t-meta">{side === "bull" ? "Against it" : "In its favour"}</p>
        {p.counter ? (
          <>
            <p className="text-[14px] text-muted">{p.counter.text}</p>
            <p className="flex flex-wrap gap-x-3">
              {p.counter.citations.slice(0, 3).map((c, i) => (
                <Cite key={i} c={c} sources={sources} />
              ))}
            </p>
          </>
        ) : (
          <p className="text-[14px] text-muted">No counterevidence on this theme in the retrieved sources.</p>
        )}
      </div>
    </li>
  );
}

export function CaseView({ report, sources, children }: { report: ResearchReport; sources: SourceMap; children?: ReactNode }) {
  const c = report.case;
  if (!c) return <EmptyState title="Not in this report">This report was built before FINN assembled a rule-based case. Rebuild it to see one.</EmptyState>;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {(["bull", "bear"] as const).map((side) => (
          <section key={side} aria-labelledby={`${side}-heading`}>
            <h3 id={`${side}-heading`} className={cx("text-[16px] font-semibold", side === "bull" ? "text-up" : "text-down")}>
              {side === "bull" ? "Bull case" : "Bear case"}
            </h3>
            {c[side].length ? (
              <ul className="divide-y divide-line">
                {c[side].map((p, i) => (
                  <Point key={i} p={p} sources={sources} side={side} />
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[14px] text-muted">Nothing in the retrieved sources supports a {side} point.</p>
            )}
          </section>
        ))}
      </div>
      <p className="t-meta">{c.note}</p>
      {children}
    </div>
  );
}

// ---- Sources -------------------------------------------------------------------------------------

export function AddSourceForm({ extras, onAdd, onRemove, disabled }: { extras: ExtraSource[]; onAdd: (e: ExtraSource) => void; onRemove: (url: string) => void; disabled?: boolean }) {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<ExtraSource["kind"]>("annual_report");
  const [period, setPeriod] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const u = url.trim();
    if (!/^https:\/\/\S+$/i.test(u)) return setError("Paste a public https link to a PDF");
    if (kind === "annual_report" && period && !/^20\d{2}$/.test(period)) return setError("An annual report's year looks like 2026 (FY26)");
    if (kind === "transcript" && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)) return setError("Give the call's month, like 2026-08, so FINN can match it to a quarter");
    setError(null);
    onAdd({ url: u, kind, ...(period ? { period } : {}) });
    setUrl("");
    setPeriod("");
  };
  return (
    <section id="add-source" aria-labelledby="add-source-heading" className="rounded-xl border border-line bg-surface px-4 py-4 sm:px-5">
      <h3 id="add-source-heading" className="text-[15px] font-semibold">
        Add a primary source
      </h3>
      <p className="mt-0.5 text-[13.5px] text-muted">
        A link to a company document FINN did not find — an annual report, a call transcript or an investor presentation from the company&apos;s or the exchange&apos;s site. It is read like the others and cited the same way. Up to three; kept on this device.
      </p>
      {/* Visible labels: on a phone a placeholder like "2026" otherwise reads as a value already filled in. */}
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-[1fr_170px_130px_auto] sm:items-end">
        <label htmlFor="source-url" className="block min-w-0">
          <span className="t-meta mb-1 block">Link to the PDF</span>
          <input
            id="source-url"
            type="url"
            inputMode="url"
            placeholder="https://…/annual-report.pdf"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="h-11 w-full min-w-0 rounded-lg border border-line-strong bg-bg px-3 text-[16px] outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
        <label htmlFor="source-kind" className="block">
          <span className="t-meta mb-1 block">Type</span>
          <select id="source-kind" value={kind} onChange={(e) => setKind(e.target.value as ExtraSource["kind"])} className="h-11 w-full rounded-lg border border-line-strong bg-bg px-2 text-[15px]">
            <option value="annual_report">Annual report</option>
            <option value="transcript">Call transcript</option>
            <option value="presentation">Presentation</option>
            <option value="other">Other document</option>
          </select>
        </label>
        <label htmlFor="source-period" className="block min-w-0">
          <span className="t-meta mb-1 block">{kind === "transcript" ? "Call month" : kind === "annual_report" ? "Year (optional)" : "Period (not needed)"}</span>
          <input
            id="source-period"
            placeholder={kind === "transcript" ? "e.g. 2026-08" : kind === "annual_report" ? "e.g. 2026" : ""}
            value={period}
            disabled={kind === "presentation" || kind === "other"}
            onChange={(e) => setPeriod(e.target.value)}
            className="h-11 w-full min-w-0 rounded-lg border border-line-strong bg-bg px-3 text-[16px] outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
          />
        </label>
        <Button type="submit" variant="primary" disabled={disabled || extras.length >= 3}>
          Add and rebuild
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-[13.5px] text-down">
          {error}
        </p>
      )}
      {disabled && <p className="t-meta mt-2">Adding sources needs live mode.</p>}
      {extras.length > 0 && (
        <ul className="mt-3 space-y-1 text-[14px]">
          {extras.map((x) => (
            <li key={x.url} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                {x.kind.replace("_", " ")}
                {x.period ? ` · ${x.period}` : ""} · {x.url}
              </span>
              <Button size="sm" variant="ghost" onClick={() => onRemove(x.url)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SourcesList({ report }: { report: ResearchReport }) {
  const primary = report.sources.filter((s) => s.primary !== false);
  const secondary = report.sources.filter((s) => s.primary === false);
  const row = (s: SourceDoc) => (
    <li key={s.id} className="flex items-start gap-3 px-4 py-3">
      <Tag tone={s.status === "used" ? "up" : s.status === "failed" ? "down" : "neutral"} className="mt-0.5 w-14 shrink-0 justify-center">
        {s.status === "used" ? "Read" : s.status === "failed" ? "Failed" : "Linked"}
      </Tag>
      <span className="min-w-0">
        <SourceLink href={s.url} className="py-1">
          {s.title}
        </SourceLink>
        <span className="t-meta block">
          {[
            s.period,
            s.coverage ? (s.coverage.truncated ? `${s.coverage.pagesRead} of ${s.coverage.totalPages} pages read` : s.coverage.totalPages ? `${s.coverage.totalPages} pages` : null) : s.pages != null ? `${s.pages} pages` : null,
            s.note,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </li>
  );
  return (
    <div className="space-y-5">
      {report.coverage && (
        <p className="text-[15px]">
          {report.provenance !== "live" && <span className="text-muted">When this {report.provenance === "demo" ? "demo" : "precomputed"} report was built ({dateTime(report.generatedAt)}): </span>}
          {report.coverage}
        </p>
      )}
      <section>
        <h3 className="t-kicker mb-2">Primary documents — the evidence</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-[14px]">{primary.map(row)}</ul>
      </section>
      <section>
        <h3 className="t-kicker mb-2">Secondary — tables and links, not evidence</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-[14px]">{secondary.map(row)}</ul>
        <p className="t-meta mt-1.5">screener.in locates the documents and supplies standardised tables; FINN traces the figures it uses to the annual report or results filing where it can, and says when a citation is document-level.</p>
      </section>
    </div>
  );
}
