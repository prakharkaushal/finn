"use client";

import Link from "next/link";
import { useId } from "react";
import type { Thresholds } from "@/lib/domain/signals";
import type { InboxResponse, PulseRow, Upcoming } from "@/lib/inbox/types";
import { dateTime, shortDate, weekdayDate } from "@/lib/format";
import { CalendarIcon } from "@/components/icons";
import { cx, Pct, ProvenanceBadge, SectionHeading, Sparkline } from "@/components/ui";

function sortByMove(rows: PulseRow[]) {
  return [...rows].sort((a, b) => Math.abs(b.signal?.changePct ?? 0) - Math.abs(a.signal?.changePct ?? 0));
}

function lastSession(rows: PulseRow[]): string | null {
  const dates = rows.map((r) => r.signal?.date).filter((d): d is string => Boolean(d)).sort();
  return dates.at(-1) ?? null;
}

/** Biggest movers in the portfolio on the last session: a horizontal strip on phones, a list on desktop. */
export function PulsePanel({ rows, layout }: { rows: PulseRow[]; layout: "strip" | "list" }) {
  if (!rows.length) return null;
  const sorted = sortByMove(rows);
  const session = lastSession(rows);
  const heading = (
    <SectionHeading title="Portfolio today" hint={session ? `Last close ${shortDate(session)} · biggest moves first` : "No price data yet"} />
  );
  if (layout === "strip") {
    return (
      <section aria-label="Portfolio pulse">
        {heading}
        <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {sorted.map((p) => (
            <li key={p.symbol}>
              <Link
                href={`/research/${encodeURIComponent(p.symbol)}`}
                className="flex min-h-11 min-w-[124px] flex-col rounded-lg border border-line bg-surface px-3 py-2 hover:border-line-strong"
              >
                <span className="num text-[12.5px] font-semibold text-muted">{p.symbol}</span>
                <span className="mt-0.5 flex items-end justify-between gap-2">
                  {p.signal ? <Pct value={p.signal.changePct} className="text-[15px] font-semibold" /> : <span className="t-meta">No data</span>}
                  {p.signal && <Sparkline values={p.signal.spark.slice(-20)} width={44} height={18} />}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <section aria-label="Portfolio pulse">
      {heading}
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {sorted.map((p) => (
          <li key={p.symbol}>
            <Link href={`/research/${encodeURIComponent(p.symbol)}`} className="flex min-h-11 items-center gap-3 px-3.5 py-2 hover:bg-surface-2/60">
              <span className="num w-24 shrink-0 truncate text-[13px] font-semibold">{p.symbol}</span>
              {p.signal ? <Sparkline values={p.signal.spark.slice(-20)} width={56} height={18} /> : <span className="w-14" />}
              <span className="ml-auto">
                {p.signal ? <Pct value={p.signal.changePct} className="text-[13.5px] font-medium" /> : <span className="t-meta">No data</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UpcomingPanel({ items, layout }: { items: Upcoming[]; layout: "inline" | "list" }) {
  if (!items.length) return null;
  if (layout === "inline") {
    return (
      <section aria-label="Results calendar" className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="inline-flex items-center gap-1.5 text-muted">
          <CalendarIcon size={14} /> Results ahead
        </span>
        {items.slice(0, 6).map((u) => (
          <a key={u.symbol} href={u.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center rounded-md bg-surface-2 px-2.5 text-muted hover:text-ink">
            <span className="num mr-1.5 font-semibold text-ink">{u.symbol}</span> {weekdayDate(u.date)}
            <span className="sr-only"> — open the board-meeting intimation</span>
          </a>
        ))}
      </section>
    );
  }
  return (
    <section aria-label="Results calendar">
      <SectionHeading title="Results calendar" hint="Board meetings announced by your companies" />
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-[14px]">
        {items.map((u) => (
          <li key={u.symbol}>
            <a href={u.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-3 px-3.5 py-2 hover:bg-surface-2/60">
              <span className="num w-24 shrink-0 font-semibold">{u.symbol}</span>
              <span className="text-muted">{weekdayDate(u.date)}</span>
              <span className="sr-only"> — open the board-meeting intimation</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every source with its status and fetch time, the coverage window and its gaps, and the active rules. */
export function SourcesPanel({ data, thresholds, className }: { data: InboxResponse; thresholds: Thresholds; className?: string }) {
  // Rendered twice (phone column and desktop sidebar), so the heading id must be unique per copy.
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cx("text-[13.5px]", className)}>
      <SectionHeading id={headingId} title="Sources & coverage" />
      <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
        <ul className="space-y-2.5">
          {data.sources.map((s) => (
            <li key={s.id}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink">{s.label}</span>
                <ProvenanceBadge provenance={s.provenance} asOf={s.asOf} />
              </div>
              {(s.asOf || s.detail) && (
                <p className="t-meta">
                  {s.asOf && `As of ${dateTime(s.asOf)}`}
                  {s.asOf && s.detail && " · "}
                  {s.detail}
                </p>
              )}
            </li>
          ))}
        </ul>
        {data.coverage.notes.length > 0 && (
          <ul className="mt-3.5 space-y-1 border-t border-line pt-3 text-muted">
            {data.coverage.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {data.coverage.gaps.length > 0 && <p className="mt-2 text-warn">NSE coverage gaps in this window: {data.coverage.gaps.join("; ")}.</p>}
        <p className="mt-3.5 border-t border-line pt-3 text-muted">
          Your rules: price move beyond ±{thresholds.pricePct}% · volume above {thresholds.volumeMultiple}× its {thresholds.lookback}-day average.{" "}
          <Link href="/settings" className="-my-1.5 inline-block py-1.5 font-medium text-accent hover:underline">
            Change rules
          </Link>
        </p>
      </div>
    </section>
  );
}
