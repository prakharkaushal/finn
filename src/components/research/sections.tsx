"use client";

import type { ReactNode } from "react";
import type { ResearchReport, SourceDoc, ThesisPoint } from "@/lib/research/types";
import { cx, EmptyState } from "@/components/ui";

export type SourceMap = Map<string, SourceDoc>;

export function citeHref(sources: SourceMap, sourceId: string, opts: { page?: number; section?: string } = {}): string | null {
  const s = sources.get(sourceId);
  if (!s) return null;
  if (opts.page) return `${s.url}#page=${opts.page}`;
  if (opts.section && s.kind === "screener") return `${s.url}#${opts.section}`;
  return s.url;
}

export const SECTION_NAME: Record<string, string> = {
  quarters: "quarterly results",
  "profit-loss": "P&L",
  "balance-sheet": "balance sheet",
  "cash-flow": "cash flow",
  ratios: "ratios",
};

/**
 * A research section: serif title, one-line scope, content. `divider` separates a second section
 * in the same view; `legend` says once how to read FINN's statements against quoted evidence.
 */
export function ReportSection({ id, title, hint, legend, divider, children }: { id: string; title: string; hint?: string; legend?: boolean; divider?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx("scroll-mt-32", divider && "border-t border-line pt-8")}>
      <h2 id={`${id}-title`} className="t-title">
        {title}
      </h2>
      {hint && <p className="mt-1 text-[13.5px] text-muted">{hint}</p>}
      {legend && (
        <p className="t-meta mt-1.5">
          Plain text is FINN&apos;s arithmetic or rule. <span className="font-medium text-muted">Source says</span> is quoted verbatim from the company&apos;s document and links to its page.
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** The report view that renders a claim, so links from elsewhere can open it. */
function claimView(id: string): string {
  return id.startsWith("bs-") || id.startsWith("cash-") || id.startsWith("wc-") ? "balance" : "financials";
}

function Point({ p, report, sources }: { p: ThesisPoint; report: ResearchReport; sources: SourceMap }) {
  const claimsById = new Map(
    [...report.headline, ...report.trajectory.claims, ...report.balanceSheet.claims, ...report.cash.claims, ...report.workingCapital.claims].map((c) => [c.id, c]),
  );
  const stmtById = new Map(report.guidance.statements.map((s) => [s.id, s]));
  return (
    <li className="text-[15px] leading-relaxed">
      {p.text}{" "}
      {p.claimIds.map((id) => (
        <a key={id} href={`?view=${claimView(id)}#claim-${id}`} title={claimsById.get(id)?.text} className="text-[12.5px] text-accent hover:underline">
          [fact]
        </a>
      ))}
      {p.statementIds.map((id) => {
        const s = stmtById.get(id);
        const href = s ? citeHref(sources, s.sourceId, { page: s.page }) : null;
        return href ? (
          <a key={id} href={href} target="_blank" rel="noopener noreferrer" title={s?.quote} className="ml-0.5 text-[12.5px] text-accent hover:underline">
            [call p.{s!.page}]
          </a>
        ) : null;
      })}
    </li>
  );
}

function ThesisList({ title, points, tone, report, sources }: { title: string; points: ThesisPoint[]; tone: string; report: ResearchReport; sources: SourceMap }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-4">
      <h3 className={cx("t-kicker", tone)}>{title}</h3>
      {points.length ? (
        <ul className="mt-2.5 list-disc space-y-2 pl-4">
          {points.map((p, i) => (
            <Point key={i} p={p} report={report} sources={sources} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[14px] text-muted">Nothing the evidence supports.</p>
      )}
    </div>
  );
}

export function ThesisBlock({ report, sources }: { report: ResearchReport; sources: SourceMap }) {
  const t = report.thesis;
  if (!t) {
    return (
      <EmptyState title="Synthesis is off">
        {report.llm.enabled
          ? "The synthesis step did not complete for this report — see the notes under Sources. Every other view is computed without it."
          : "A cited bull and bear case is written only when an LLM key is configured on the server. Every other view is computed from the filings without one."}
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      <ThesisList title="Bull case" points={t.bull} tone="text-up" report={report} sources={sources} />
      <ThesisList title="Bear case" points={t.bear} tone="text-down" report={report} sources={sources} />
      {t.divergences.length > 0 && <ThesisList title="Narrative vs numbers" points={t.divergences} tone="text-accent" report={report} sources={sources} />}
      <p className="t-meta">
        Written by {t.model} from the facts and quotes in this report only; every point cites them{t.dropped ? `, and ${t.dropped} uncited point(s) were discarded` : ""}.
      </p>
    </div>
  );
}
