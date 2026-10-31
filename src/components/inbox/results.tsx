"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { describeChange, formatCroreInr, type Change } from "@/lib/domain/numbers";
import type { HeadlineMetric, ResultsSnapshot } from "@/lib/domain/results";
import { quarterOf } from "@/lib/domain/periods";
import { clock } from "@/lib/format";
import type { ResultsAttachment } from "@/lib/inbox/types";
import { ChangeText, Skeleton, SourceLink } from "@/components/ui";

export type ResultsResponse = {
  snapshot: ResultsSnapshot;
  source: { label: string; url: string };
  provenance: string;
  fetchedAt: string;
};

export type ResultsState =
  | { status: "loading" }
  | { status: "ready"; data: ResultsResponse }
  | { status: "error"; error: string };

/** Lets the design-review gallery supply fixture numbers instead of calling the API. */
export const ResultsFixtureContext = createContext<Record<string, ResultsResponse> | null>(null);

function fromAttachment(a: ResultsAttachment): ResultsState {
  if (a.snapshot && a.source) {
    return { status: "ready", data: { snapshot: a.snapshot, source: { label: a.source.label, url: a.source.url }, provenance: a.source.provenance, fetchedAt: a.source.fetchedAt } };
  }
  return { status: "error", error: a.error ?? "statements unavailable" };
}

/** Numbers the server attached win; otherwise they are fetched when the card first renders. */
export function useResults(query: { symbol: string; periodEnd: string } | null, attached?: ResultsAttachment): ResultsState | null {
  const fixtures = useContext(ResultsFixtureContext);
  const key = query ? `${query.symbol}:${query.periodEnd}` : null;
  const fixture = key && fixtures ? fixtures[key] : undefined;
  const preset = fixture != null || attached != null;
  const [state, setState] = useState<ResultsState>({ status: "loading" });

  useEffect(() => {
    if (!query || preset) return;
    const ctrl = new AbortController();
    fetch(`/api/results?symbol=${encodeURIComponent(query.symbol)}&period=${query.periodEnd}`, { signal: ctrl.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `Server responded ${r.status}`);
        setState({ status: "ready", data: body as ResultsResponse });
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setState({ status: "error", error: e instanceof Error ? e.message : "Could not load numbers" });
      });
    return () => ctrl.abort();
    // The query object is rebuilt each render; its identity is captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, preset]);

  if (!query) return null;
  if (fixture) return { status: "ready", data: fixture };
  if (attached) return fromAttachment(attached);
  return state;
}

function clause(label: string, c: Change): string | null {
  if (c.kind === "pct") return `${label} ${c.value >= 0 ? "+" : "−"}${Math.abs(c.value).toFixed(1)}% YoY`;
  if (c.kind === "na") return null;
  return `${label} ${describeChange(c)} YoY`;
}

/** The "why it may matter" line for a results filing: the actual headline numbers, once known. */
export function resultsWhy(state: ResultsState | null): string | null {
  if (!state || state.status !== "ready" || state.data.snapshot.status !== "ok") return null;
  const m = Object.fromEntries(state.data.snapshot.metrics.filter((x) => x.status === "ok").map((x) => [x.key, x]));
  const parts = [m.revenue && clause("Revenue", m.revenue.yoy), m.pat && clause("PAT", m.pat.yoy)].filter(Boolean) as string[];
  const margin = state.data.snapshot.margins[0];
  if (margin?.yoyBps != null && !state.data.snapshot.isLender) parts.push(`${margin.label} ${margin.yoyBps >= 0 ? "+" : "−"}${Math.abs(margin.yoyBps)} bps`);
  return parts.length ? `${parts.join(" · ")}.` : null;
}

function MetricRow({ m }: { m: HeadlineMetric }) {
  if (m.status !== "ok") {
    return (
      <tr className="border-t border-line" title={m.definition}>
        <th scope="row" className="truncate py-2 text-left font-normal text-muted">
          {m.label}
        </th>
        <td colSpan={3} className="py-2 text-right text-[13px] text-muted">
          {m.status === "not-applicable" ? "Not meaningful for a lender" : "Not found in source"}
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-t border-line" title={m.definition}>
      <th scope="row" className="truncate py-2 text-left font-normal text-muted">
        {m.label}
      </th>
      <td className="num truncate py-2 text-right font-medium">{formatCroreInr(m.current, 0, "")}</td>
      <td className="py-2 text-right text-[13px]">
        <ChangeText change={m.yoy} />
      </td>
      <td className="py-2 text-right text-[13px]">
        <ChangeText change={m.qoq} />
      </td>
    </tr>
  );
}

const label = (key: string | null) => (key ? (quarterOf(key)?.label ?? key) : "not in source");

export function ResultsTable({ state, filingUrl }: { state: ResultsState; filingUrl: string }) {
  if (state.status === "loading") {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading headline numbers">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-10/12" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13.5px] text-ink">
        Numbers unavailable ({state.error}). The filing has them: <SourceLink href={filingUrl}>results PDF</SourceLink>
      </p>
    );
  }
  const { snapshot, source, fetchedAt } = state.data;
  if (snapshot.status === "quarter-missing") {
    const latest = snapshot.latestAvailable ? (quarterOf(snapshot.latestAvailable)?.label ?? snapshot.latestAvailable) : "none";
    return (
      <p className="rounded-lg bg-warn-soft px-3 py-2.5 text-[13.5px] text-ink">
        screener.in has not added {snapshot.quarter?.label ?? "this quarter"} yet (latest there: {latest}), so FINN shows no numbers rather than guess.{" "}
        <SourceLink href={filingUrl}>Read them in the filing</SourceLink>
      </p>
    );
  }
  return (
    <div>
      <p className="t-meta mb-1.5">
        {snapshot.quarter.label} against {label(snapshot.comparedWith.yearAgo)} (YoY) and {label(snapshot.comparedWith.prevQuarter)} (QoQ) · {snapshot.units.replace(" ", "\u00a0")}
        {snapshot.convertedFrom ? `, converted from ${snapshot.convertedFrom}` : ""}
      </p>
      <table className="w-full table-fixed text-[14px]">
        <caption className="sr-only">
          Headline numbers for {snapshot.quarter.label}, {snapshot.units}, {snapshot.basis}, compared with the previous quarter and the same quarter last year
        </caption>
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[26%]" />
          <col className="w-[22%]" />
          <col className="w-[22%]" />
        </colgroup>
        <thead>
          <tr className="t-kicker text-[11.5px]">
            <th scope="col" className="pb-1.5 text-left font-semibold">
              {snapshot.basis === "consolidated" ? "Consol." : "Standalone"}
            </th>
            <th scope="col" className="whitespace-nowrap pb-1.5 text-right font-semibold">
              {snapshot.quarter.label}
            </th>
            <th scope="col" className="pb-1.5 text-right font-semibold">
              YoY
            </th>
            <th scope="col" className="pb-1.5 text-right font-semibold">
              QoQ
            </th>
          </tr>
        </thead>
        <tbody>
          {snapshot.metrics.map((m) => (
            <MetricRow key={m.key} m={m} />
          ))}
        </tbody>
      </table>
      <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
        {snapshot.margins.map((mg) => (
          <span key={mg.label} className="mr-4 inline-block">
            {mg.label} <span className="num font-medium text-ink">{mg.current == null ? "—" : `${mg.current.toFixed(1)}%`}</span>
            {mg.yoyBps != null && (
              <>
                {" "}
                <span className={mg.yoyBps >= 0 ? "num text-up" : "num text-down"}>
                  {mg.yoyBps >= 0 ? "+" : "−"}
                  {Math.abs(mg.yoyBps)}
                </span>{" "}
                bps YoY
              </>
            )}
          </span>
        ))}
      </p>
      <p className="t-meta mt-1.5">
        Reported figures from <SourceLink href={source.url}>{source.label}</SourceLink>, {snapshot.basis} only (never mixed with {snapshot.basis === "consolidated" ? "standalone" : "consolidated"}); changes computed by FINN · fetched {clock(fetchedAt)} IST
        {snapshot.isLender && " · lender: NII shown instead of EBITDA"}
      </p>
    </div>
  );
}
