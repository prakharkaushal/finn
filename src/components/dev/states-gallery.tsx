"use client";

import { useState } from "react";
import type { ResearchReport } from "@/lib/research/types";
import { DEFAULT_THRESHOLDS } from "@/lib/domain/signals";
import type { WindowKey } from "@/lib/inbox/types";
import { degradedInbox, quietInbox, SAMPLE_NOTICE, sampleInbox, sampleResults } from "@/fixtures/inbox-sample";
import { InboxScreen } from "@/components/inbox/inbox-screen";
import { ResultsFixtureContext } from "@/components/inbox/results";
import { ResearchScreen, type ResearchView } from "@/components/research/research-screen";
import type { ResearchStep } from "@/components/research/use-research";

/**
 * Design-review gallery (development only): every inbox and research state rendered by the
 * real screens from labelled sample data, so states can be reviewed without breaking a source.
 */

const STATES = [
  "inbox-normal",
  "inbox-loading",
  "inbox-error",
  "inbox-degraded",
  "inbox-quiet",
  "inbox-all-done",
  "research-building",
  "research-error",
  "research-report",
  "research-no-transcripts",
] as const;
type State = (typeof STATES)[number];

// The step labels the live pipeline streams, in order.
const STEPS: ResearchStep[] = [
  { id: "company", label: "Finding the company", status: "done", detail: "Kaynes Technology India · consolidated statements" },
  { id: "financials", label: "Computing growth, margins, leverage and cash conversion", status: "done" },
  { id: "prices", label: "Fetching end-of-day prices", status: "done", detail: "Yahoo Finance chart (end of day) · KAYNES.NS" },
  { id: "sources", label: "Finding the company's own documents", status: "done", detail: "1 annual report, 4 transcripts, 1 presentation, 1 results filing" },
  { id: "documents", label: "Reading the documents", status: "running" },
];

const noop = () => {};

export function StatesGallery({ report }: { report: ResearchReport }) {
  const [state, setState] = useState<State>("inbox-normal");
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");
  const [done, setDone] = useState<Record<string, number>>({});
  const [view, setView] = useState<ResearchView>("business");
  const allDone = Object.fromEntries(sampleInbox.items.filter((i) => i.tier === "attention").map((i) => [i.id, 1]));

  const inboxBase = {
    windowKey,
    onWindowChange: setWindowKey,
    portfolioSize: 20,
    thresholds: DEFAULT_THRESHOLDS,
    onDone: (id: string) => setDone((d) => ({ ...d, [id]: Date.now() })),
    onUndo: (id: string) =>
      setDone((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      }),
    onRefresh: noop,
    sampleNotice: SAMPLE_NOTICE,
  };
  const researchBase = {
    symbol: report.symbol,
    inPortfolio: false,
    onToggleWatch: noop,
    onRebuild: noop,
    onRetry: noop,
    view,
    onView: setView,
    extras: [],
    onAddSource: noop,
    onRemoveSource: noop,
  };
  const noTranscripts: ResearchReport = {
    ...report,
    sources: report.sources.filter((s) => s.kind !== "transcript"),
    guidance: { ...report.guidance, status: "no_transcripts", statements: [], revisions: [], transcriptsRead: 0 },
    checks: [],
  };

  return (
    <ResultsFixtureContext.Provider value={sampleResults}>
      <div className="border-b border-sample/30 bg-sample-soft">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5 lg:px-8">
          <span className="text-[14px] font-semibold text-sample">Design review · sample data</span>
          <label htmlFor="state" className="text-[13.5px] text-ink">
            State
          </label>
          <select id="state" value={state} onChange={(e) => setState(e.target.value as State)} className="min-h-10 rounded-md border border-line-strong bg-surface px-2 text-[14px]">
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      {state === "inbox-normal" && <InboxScreen {...inboxBase} data={sampleInbox} loading={false} done={done} />}
      {state === "inbox-loading" && <InboxScreen {...inboxBase} loading done={{}} />}
      {state === "inbox-error" && <InboxScreen {...inboxBase} loading={false} done={{}} error="Server responded 502: NSE announcements feed unreachable (fetch failed)" />}
      {state === "inbox-degraded" && <InboxScreen {...inboxBase} data={degradedInbox} loading={false} done={done} />}
      {state === "inbox-quiet" && <InboxScreen {...inboxBase} data={quietInbox} loading={false} done={{}} />}
      {state === "inbox-all-done" && <InboxScreen {...inboxBase} data={sampleInbox} loading={false} done={allDone} />}
      {state === "research-building" && <ResearchScreen {...researchBase} steps={STEPS} report={null} error={null} loading />}
      {state === "research-error" && (
        <ResearchScreen {...researchBase} symbol="ZZZZ" steps={[]} report={null} loading={false} error="ZZZZ is not an NSE-listed equity (checked NSE's master list as of 2026-10-27)." />
      )}
      {state === "research-report" && <ResearchScreen {...researchBase} steps={[]} report={report} error={null} loading={false} sampleNotice={SAMPLE_NOTICE} />}
      {state === "research-no-transcripts" && <ResearchScreen {...researchBase} steps={[]} report={noTranscripts} error={null} loading={false} sampleNotice={SAMPLE_NOTICE} />}
    </ResultsFixtureContext.Provider>
  );
}
