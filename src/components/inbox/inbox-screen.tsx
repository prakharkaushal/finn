"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CATEGORY_LABEL, type Category } from "@/lib/domain/categories";
import type { Thresholds } from "@/lib/domain/signals";
import { WINDOWS, type FilingItem, type InboxItem, type InboxResponse, type MarketItem, type SourceStatus, type WindowKey } from "@/lib/inbox/types";
import { clock, dateTime, shortDate, todayLabel } from "@/lib/format";
import { TodayLabel } from "@/components/client-time";
import { BoltIcon, ChevronDownIcon, RefreshIcon } from "@/components/icons";
import { DoneRow, FilingRow, MarketRow, priceSourceName, RoutineRow, type AlertMark } from "@/components/inbox/items";
import { PulsePanel, SourcesPanel, UpcomingPanel } from "@/components/inbox/panels";
import { useAlertLog } from "@/components/inbox/use-alert-log";
import { PageFrame } from "@/components/shell";
import { Button, ButtonLink, cx, EmptyState, Ledger, ProvenanceBadge, SectionHeading, SegmentedControl, Skeleton, StatusNotice, type DisplayProvenance } from "@/components/ui";

/**
 * The inbox, as a pure view of an InboxResponse. Data loading lives in InboxView; the design
 * gallery renders this same component from labelled sample fixtures.
 *
 * Order on a phone: what needs you (material filings, then the price and volume rules that
 * fired, compact), then what is worth a look, and only then context — the portfolio strip, the
 * results calendar, routine paperwork and sources.
 */

export type InboxScreenProps = {
  data?: InboxResponse;
  error?: string;
  loading: boolean;
  windowKey: WindowKey;
  onWindowChange: (w: WindowKey) => void;
  portfolioSize: number;
  thresholds: Thresholds;
  done: Record<string, number>;
  onDone: (id: string) => void;
  onUndo: (id: string) => void;
  onRefresh: () => void;
  /** Shown when the screen renders design fixtures instead of live data. */
  sampleNotice?: string;
  /** Offered when live sources fail and this visit may switch to the committed demo dataset. */
  onUseDemo?: () => void;
};

const WINDOW_WORDS: Record<WindowKey, string> = { "24h": "24 hours", "3d": "3 days", "7d": "7 days", "30d": "30 days" };
const WINDOW_OPTIONS = (Object.keys(WINDOWS) as WindowKey[]).map((w) => ({ value: w, label: w, title: `Last ${WINDOW_WORDS[w]}` }));

const RANK: Record<SourceStatus["provenance"], number> = { live: 0, cache: 1, stale: 2, snapshot: 3, demo: 4, sample: 5, error: 6 };

/**
 * Filings and prices decide the brief's status. Listings are alternatives to each other, so
 * filings count as live when any listing is; prices are already summarised in one row.
 */
function overall(data: InboxResponse): { provenance: DisplayProvenance; label: string } {
  if (data.dataMode === "demo") return { provenance: "demo", label: "Demo data" };
  const listings = data.sources.filter((s) => s.role === "announcements");
  const filings = listings.length ? listings.reduce((best, s) => (RANK[s.provenance] < RANK[best.provenance] ? s : best)).provenance : "error";
  const prices = data.sources.find((s) => s.role === "prices")?.provenance ?? "error";
  const both = [filings, prices];
  if (both.includes("sample")) return { provenance: "sample", label: "Sample data" };
  if (both.includes("error")) return { provenance: "error", label: "Partly unavailable" };
  if (both.some((p) => p === "stale" || p === "snapshot")) return { provenance: "stale", label: "Partly cached" };
  return { provenance: "live", label: "Live" };
}

/** Plain statements about any source that is not live, for the notice under the brief. */
function degraded(data: InboxResponse): string[] {
  if (data.dataMode === "demo") return [];
  const out: string[] = [];
  const listings = data.sources.filter((s) => s.role === "announcements");
  const liveListing = listings.some((s) => s.provenance === "live" || s.provenance === "cache");
  for (const s of listings) {
    if (s.provenance === "error") out.push(`${s.label} could not be read${liveListing ? "" : ", so filings come from FINN's archive only"} (${s.detail ?? "no detail"}).`);
    if (s.provenance === "stale") out.push(`${s.label} failed to refresh; its filings are from the last copy (${s.asOf ? dateTime(s.asOf) : "earlier"}).`);
  }
  const prices = data.sources.find((s) => s.role === "prices");
  if (prices && (prices.provenance === "stale" || prices.provenance === "snapshot" || prices.provenance === "error")) {
    out.push(prices.provenance === "error" ? "Prices are unavailable, so price and volume rules are paused." : `Some prices are not live (${prices.detail ?? ""}).`);
  }
  return out;
}

type FilterKey = Category | "market";
const keyOf = (i: InboxItem): FilterKey => (i.kind === "market" ? "market" : i.category);
const filterLabel = (k: FilterKey) => (k === "market" ? "Price & volume" : CATEGORY_LABEL[k]);

function FilterChip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className={cx(
        "flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-medium transition-colors",
        on ? "border-ink bg-ink text-bg" : "border-line-strong bg-surface text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function LoadingList() {
  return (
    <div aria-busy="true" aria-label="Loading your inbox" className="mt-8">
      <p className="t-meta mb-3">The first check reads every source and can take 20–40 seconds; after that it opens from FINN&apos;s short-lived cache.</p>
      <Skeleton className="mb-3 h-3 w-32" />
      <div className="divide-y divide-line rounded-xl border border-line bg-surface">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="px-4 py-4">
            <Skeleton className="h-3 w-44" />
            <Skeleton className="mt-3 h-4 w-3/4" />
            <Skeleton className="mt-2.5 h-3 w-full" />
            <Skeleton className="mt-3 h-6 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Yahoo Finance chart" — the price sources behind the rules that fired, without their parentheticals. */
function priceSources(moves: MarketItem[]): string {
  return [...new Set(moves.map((m) => priceSourceName(m.priceSource.label)))].join(", ");
}

/** "the 28 Oct close", or "each company's last close" when sessions differ. */
function sessionWords(moves: MarketItem[]): string {
  const dates = [...new Set(moves.map((m) => m.signal.date))];
  return dates.length === 1 ? `the ${shortDate(dates[0])} close` : "each company's last close";
}

export function InboxScreen(p: InboxScreenProps) {
  const [routineOpen, setRoutineOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<FilterKey>>(new Set());
  const { data } = p;
  const { fresh, log } = useAlertLog(data);
  // "New" means new since this device last looked; on a first visit everything is, so nothing is marked.
  const hasHistory = useMemo(() => Object.keys(log).some((id) => !fresh.has(id)), [log, fresh]);

  const groups = useMemo(() => {
    const items = data?.items ?? [];
    const inView = (i: InboxItem) => !alertsOnly || i.triggered;
    const shown = items.filter((i) => inView(i) && (picked.size === 0 || picked.has(keyOf(i))));
    const active = shown.filter((i) => !p.done[i.id]);
    const counts = new Map<FilterKey, number>();
    for (const i of items) if (inView(i)) counts.set(keyOf(i), (counts.get(keyOf(i)) ?? 0) + 1);
    const alerts = items.filter((i) => i.triggered);
    // In the alerts view, what this device has not seen yet comes first.
    const order = (a: InboxItem, b: InboxItem) => (alertsOnly ? Number(fresh.has(b.id)) - Number(fresh.has(a.id)) : 0) || b.score - a.score;
    return {
      attention: active.filter((i): i is FilingItem => i.tier === "attention" && i.kind === "filing").sort(order),
      moves: active.filter((i): i is MarketItem => i.kind === "market").sort(order),
      look: active.filter((i) => i.tier === "look"),
      routine: active.filter((i): i is FilingItem => i.tier === "routine" && i.kind === "filing"),
      done: shown.filter((i) => p.done[i.id]),
      total: items.length,
      shown: shown.length,
      attentionTotal: items.filter((i) => i.tier === "attention").length,
      alertTotal: alerts.length,
      newAlerts: alerts.filter((i) => fresh.has(i.id)).length,
      categories: [...counts].sort((a, b) => b[1] - a[1]),
    };
  }, [data, p.done, alertsOnly, picked, fresh]);
  const filtered = alertsOnly || picked.size > 0;
  const togglePick = (k: FilterKey) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const markOf = (item: InboxItem): AlertMark | undefined =>
    item.triggered ? { fresh: hasHistory && fresh.has(item.id), firstSeenAt: log[item.id]?.firstSeenAt } : undefined;
  const row = (item: InboxItem) =>
    item.kind === "market" ? (
      <MarketRow key={item.id} item={item} onDone={() => p.onDone(item.id)} alert={markOf(item)} />
    ) : (
      <FilingRow key={item.id} item={item} onDone={() => p.onDone(item.id)} alert={markOf(item)} />
    );

  const status = data ? overall(data) : null;
  const notices = data ? degraded(data) : [];
  // The words describe the window the data on screen was computed for, which lags the control
  // while a newly picked window loads.
  const shownWindow = data?.window.key ?? p.windowKey;
  const windowWords = WINDOW_WORDS[shownWindow];
  const switching = Boolean(data && p.loading && data.window.key !== p.windowKey);
  // Every symbol unknown: FINN watched nothing, which is not a quiet day.
  const watchedNone = Boolean(data && p.portfolioSize > 0 && data.unknownSymbols.length >= p.portfolioSize);
  const left = groups.attention.length + groups.moves.length;

  // No title (a skeleton) only while the first check is still running.
  let title: string | null = null;
  if (data) {
    if (left > 0) title = `${left} ${left === 1 ? "thing needs" : "things need"} you`;
    else if (groups.attentionTotal > 0 && !filtered) title = "You're through what needed you";
    else title = "Nothing needs you right now";
  } else if (p.error && !p.loading) {
    title = "Couldn't check your companies";
  }
  if (watchedNone) title = "FINN can't watch any of your symbols";

  const main = (
    <>
      <header>
        <p className="t-kicker">
          {/* Replayed data is dated by its capture, never by today's clock. */}
          Inbox · {data && data.dataMode !== "live" ? `${todayLabel(Date.parse(data.generatedAt))} · ${data.dataMode === "demo" ? "demo capture" : "sample"}` : <TodayLabel />}
        </p>
        {title ? (
          <h1 className="t-display mt-2 lg:text-[36px]">{title}</h1>
        ) : (
          <>
            <h1 className="sr-only">Your inbox</h1>
            <Skeleton className="mt-3 h-8 w-64" />
          </>
        )}
        <p className="mt-2 text-[14.5px] text-muted">
          {data
            ? groups.total === 0
              ? `No filings and no alerts · ${p.portfolioSize} companies · last ${windowWords}`
              : [groups.look.length && `${groups.look.length} worth a look`, groups.routine.length && `${groups.routine.length} routine, tucked away`, `${p.portfolioSize} companies`, `last ${windowWords}`]
                  .filter(Boolean)
                  .join(" · ")
            : title
              ? `The check of ${p.portfolioSize} companies failed — details below.`
              : `Checking ${p.portfolioSize} companies for filings and price moves…`}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-3">
          <SegmentedControl label="Time window" options={WINDOW_OPTIONS} value={p.windowKey} onChange={p.onWindowChange} />
          <div className="flex items-center gap-1">
            {status && data && <ProvenanceBadge provenance={status.provenance} label={status.label} asOf={data.generatedAt} withTime />}
            <Button variant="ghost" size="sm" onClick={p.onRefresh} disabled={p.loading} aria-busy={p.loading} aria-label={p.loading ? "Refreshing" : "Refresh"} className="max-sm:w-10 max-sm:px-0">
              <RefreshIcon size={15} className={p.loading ? "animate-spin" : undefined} />
              <span className="max-sm:hidden">{p.loading ? "Refreshing" : "Refresh"}</span>
            </Button>
          </div>
        </div>
        {switching && (
          <p className="t-meta mt-2" role="status">
            Loading the last {WINDOW_WORDS[p.windowKey]} — still showing the last {windowWords} until it arrives.
          </p>
        )}
      </header>

      {/* Anything wrong with the data comes before the data. */}
      <div className="mt-5 space-y-3 empty:hidden">
        {p.sampleNotice && (
          <StatusNotice tone="sample" title="Sample data">
            {p.sampleNotice}
          </StatusNotice>
        )}
        {p.error && !data && (
          <StatusNotice
            tone="error"
            title="Couldn't load your inbox"
            action={
              <div className="flex flex-wrap gap-2">
                <Button onClick={p.onRefresh}>Try again</Button>
                {p.onUseDemo && (
                  <Button variant="ghost" onClick={p.onUseDemo}>
                    Use demo data instead
                  </Button>
                )}
              </div>
            }
          >
            {p.error}
          </StatusNotice>
        )}
        {p.error && data && (
          <StatusNotice tone="warn" title={`Refresh failed — showing the inbox from ${clock(data.generatedAt)}`} action={<Button size="sm" onClick={p.onRefresh}>Try again</Button>}>
            {p.error}
          </StatusNotice>
        )}
        {notices.length > 0 && (
          <StatusNotice
            tone="warn"
            title="Some sources are not live"
            action={
              p.onUseDemo && (
                <Button size="sm" variant="ghost" className="-ml-3" onClick={p.onUseDemo}>
                  Use demo data instead
                </Button>
              )
            }
          >
            <ul className="list-disc space-y-0.5 pl-4">
              {notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </StatusNotice>
        )}
        {data && data.unknownSymbols.length > 0 && (
          <StatusNotice tone="warn" title="Some symbols aren't on NSE" action={<ButtonLink href="/settings" size="sm">Fix in settings</ButtonLink>}>
            {data.unknownSymbols.join(", ")} {data.unknownSymbols.length === 1 ? "is" : "are"} not on NSE&apos;s equity list, so FINN can&apos;t watch {data.unknownSymbols.length === 1 ? "it" : "them"}.
          </StatusNotice>
        )}
      </div>

      {data && groups.total > 0 && (
        <div className="mt-6 space-y-2" role="group" aria-label="Filter the inbox">
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:px-0">
            <FilterChip on={alertsOnly} onClick={() => setAlertsOnly((a) => !a)} title="Only items one of your rules triggered">
              <BoltIcon size={13} className={alertsOnly ? undefined : "text-signal"} />
              Alerts <span className="num">{groups.alertTotal}</span>
              {hasHistory && groups.newAlerts > 0 && <span className="font-normal">· {groups.newAlerts} new</span>}
            </FilterChip>
            <span aria-hidden="true" className="my-2 w-px shrink-0 bg-line-strong" />
            {groups.categories.map(([k, n]) => (
              <FilterChip key={k} on={picked.has(k)} onClick={() => togglePick(k)}>
                {filterLabel(k)} <span className="num">{n}</span>
              </FilterChip>
            ))}
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPicked(new Set());
                  setAlertsOnly(false);
                }}
              >
                Clear
              </Button>
            )}
          </div>
          {filtered && (
            <p className="t-meta" aria-live="polite">
              Showing {groups.shown} of {groups.total}
              {alertsOnly ? " · alerts only" : ""}
              {picked.size ? ` · ${[...picked].map(filterLabel).join(", ")}` : ""}
            </p>
          )}
        </div>
      )}

      {!data && !p.error && <LoadingList />}

      {data && groups.total === 0 && !watchedNone && (
        <div className="mt-8">
          <EmptyState
            title={`Quiet ${shownWindow === "24h" ? "day" : "stretch"}`}
            action={shownWindow !== "7d" && shownWindow !== "30d" ? <Button onClick={() => p.onWindowChange("7d")}>Look back 7 days</Button> : undefined}
          >
            No filings and no price or volume alerts from your {p.portfolioSize} companies in the last {windowWords}.
          </EmptyState>
        </div>
      )}

      {data && groups.total > 0 && (
        <div className={cx("mt-6 space-y-8 transition-opacity", switching && "opacity-50")} aria-busy={switching}>
          {groups.attention.length > 0 ? (
            <section aria-labelledby="attention-heading">
              <SectionHeading id="attention-heading" title={alertsOnly ? "Filing alerts" : "Needs attention"} count={groups.attention.length} hint="Material filings: results, key people, deals, legal" />
              <Ledger labelledBy="attention-heading">{groups.attention.map(row)}</Ledger>
            </section>
          ) : groups.moves.length > 0 ? (
            <p className="t-meta">No material filings{alertsOnly ? " triggered an alert" : ""} in the last {windowWords}{picked.size ? " for the filters you picked" : ""}.</p>
          ) : (
            <EmptyState
              title={alertsOnly ? "No alerts" : groups.attentionTotal && !filtered ? "All clear" : "Nothing material"}
              action={p.windowKey === "24h" && !groups.attentionTotal ? <Button onClick={() => p.onWindowChange("7d")}>Look back 7 days</Button> : undefined}
            >
              {alertsOnly
                ? `None of your rules fired in the last ${windowWords}${picked.size ? " for the filters you picked" : ""}.`
                : groups.attentionTotal && !filtered
                  ? "You've marked everything that needed you as done. Undo below if you need it back."
                  : `No results, key people changes, deals or rule breaches in the last ${windowWords}${picked.size ? " for the filters you picked" : ""}.`}
            </EmptyState>
          )}

          {groups.moves.length > 0 && (
            <section aria-labelledby="moves-heading">
              <SectionHeading
                id="moves-heading"
                title="Price & volume alerts"
                count={groups.moves.length}
                hint={`Your rules on ${sessionWords(groups.moves)} · end-of-day prices from ${priceSources(groups.moves)}`}
              />
              <Ledger labelledBy="moves-heading">{groups.moves.map(row)}</Ledger>
            </section>
          )}

          {alertsOnly && (
            <p className="t-meta">
              Alerts show here, in FINN. FINN does not send email or phone notifications yet —{" "}
              <a href="/settings#delivery" className="-my-1 inline-block py-1 text-accent hover:underline">
                what external delivery would need
              </a>
              . An alert is new the first time this device sees it; the same event never alerts twice.
            </p>
          )}

          {!alertsOnly && groups.look.length > 0 && (
            <section aria-labelledby="look-heading">
              <SectionHeading id="look-heading" title="Worth a look" count={groups.look.length} />
              <Ledger labelledBy="look-heading">{groups.look.map(row)}</Ledger>
            </section>
          )}

          {/* Context, after the decisions: the desktop sidebar holds these instead. */}
          <div className="space-y-4 lg:hidden">
            <PulsePanel rows={data.pulse} layout="strip" />
            <UpcomingPanel items={data.upcoming} layout="inline" />
          </div>

          {!alertsOnly && groups.routine.length > 0 && (
            <section aria-label="Routine filings" className="rounded-xl border border-line bg-surface">
              <button
                type="button"
                onClick={() => setRoutineOpen((o) => !o)}
                aria-expanded={routineOpen}
                aria-controls="routine-list"
                className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left sm:px-5"
              >
                <span>
                  <span className="block text-[15px] font-semibold">
                    {groups.routine.length} routine filing{groups.routine.length === 1 ? "" : "s"}
                  </span>
                  <span className="block text-[13px] text-muted">Call recordings, ESOP grants, compliance paperwork</span>
                </span>
                <ChevronDownIcon size={18} className={cx("shrink-0 text-muted transition-transform", routineOpen && "rotate-180")} />
              </button>
              <ul id="routine-list" hidden={!routineOpen} className="divide-y divide-line border-t border-line">
                {groups.routine.map((item) => (
                  <RoutineRow key={item.id} item={item} />
                ))}
              </ul>
            </section>
          )}

          {groups.done.length > 0 && (
            <section aria-label="Marked done">
              <Button variant="ghost" size="sm" onClick={() => setDoneOpen((o) => !o)} aria-expanded={doneOpen} aria-controls="done-list" className="-ml-3">
                {groups.done.length} marked done
                <ChevronDownIcon size={15} className={cx("transition-transform", doneOpen && "rotate-180")} />
              </Button>
              <Ledger id="done-list" className={cx("mt-1", !doneOpen && "hidden")}>
                {groups.done.map((item) => (
                  <DoneRow key={item.id} item={item} onUndo={() => p.onUndo(item.id)} />
                ))}
              </Ledger>
            </section>
          )}
        </div>
      )}

      {data && <SourcesPanel data={data} thresholds={p.thresholds} className="mt-10 lg:hidden" />}
    </>
  );

  return (
    <PageFrame>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-12">
        <div className="min-w-0">{main}</div>
        {data && (
          <aside aria-label="Portfolio and sources" className="hidden space-y-8 lg:block">
            <PulsePanel rows={data.pulse} layout="list" />
            <UpcomingPanel items={data.upcoming} layout="list" />
            <SourcesPanel data={data} thresholds={p.thresholds} />
          </aside>
        )}
      </div>
    </PageFrame>
  );
}
