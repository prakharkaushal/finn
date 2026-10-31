"use client";

import Link from "next/link";
import { useId, useRef, useState, type ReactNode } from "react";
import { CATEGORY_LABEL, TIER_LABEL } from "@/lib/domain/categories";
import type { ScoreComponent } from "@/lib/domain/materiality";
import { triggerLine } from "@/lib/inbox/alerts";
import { formatCrore } from "@/lib/domain/numbers";
import type { FilingDoc, FilingItem, InboxItem, MarketItem } from "@/lib/inbox/types";
import { clock, dateTime, shortDate } from "@/lib/format";
import { RelativeTime } from "@/components/client-time";
import { BoltIcon, CheckIcon, ChevronDownIcon, ChevronIcon, ExternalIcon, UndoIcon } from "@/components/icons";
import { PeoplePanel } from "@/components/inbox/people-panel";
import { ResultsTable, resultsWhy, useResults } from "@/components/inbox/results";
import { Button, buttonClass, cx, Pct, ProvenanceBadge, SourceLink, Sparkline, Tag } from "@/components/ui";

/** A price source as it reads in a sentence: "Yahoo Finance chart", "FINN's demo dataset". */
export function priceSourceName(label: string): string {
  const seed = label.match(/^(Demo dataset|Committed snapshot): end-of-day prices$/);
  if (seed) return seed[1] === "Demo dataset" ? "FINN's demo dataset" : "FINN's committed snapshot";
  return label.replace(/\s*\(.*\)$/, "");
}

function docLabel(doc: FilingDoc) {
  if (doc.docType === "xbrl") return `${doc.exchange} XBRL`;
  if (doc.docType === "zip") return `${doc.exchange} filing (zip)`;
  return `${doc.exchange} filing`;
}

function sourceSentence(item: FilingItem) {
  if (item.provenance === "sample") return "Sample item for design review — not a real-time filing.";
  if (item.provenance === "demo") return `Demo data: a real ${item.primary.exchange} filing replayed from FINN's capture of ${dateTime(item.asOf)}; not live.`;
  if (item.via === "nse-rss") return `From NSE's announcements feed, fetched ${dateTime(item.asOf)}.`;
  if (item.via === "nse-api") return `From NSE's corporate-announcements listing, fetched ${dateTime(item.asOf)}.`;
  if (item.via === "screener") return `BSE filing listed on screener.in, captured in FINN's archive ${dateTime(item.asOf)}.`;
  return `From FINN's archive of NSE filings, captured ${dateTime(item.asOf)}.`;
}

function ItemMeta({ symbol, company, children }: { symbol: string; company: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      {/* The padding widens the tap target without moving the line. */}
      <Link href={`/research/${encodeURIComponent(symbol)}`} className="num -mx-1 -my-1.5 min-w-6 shrink-0 px-1 py-1.5 text-center font-semibold text-ink hover:text-accent" aria-label={`${symbol}: open research`}>
        {symbol}
      </Link>
      <span className="min-w-0 truncate text-muted">{company}</span>
      <span className="t-meta ml-auto flex shrink-0 items-baseline gap-1.5">{children}</span>
    </div>
  );
}

function Headline({ text, open, onToggle, controls, size = "md" }: { text: string; open: boolean; onToggle: () => void; controls: string; size?: "md" | "sm" }) {
  return (
    <h3 className={size === "md" ? "mt-1.5" : "mt-1"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={controls}
        className="group -my-1.5 flex w-full items-start justify-between gap-3 rounded-md py-1.5 text-left"
      >
        <span className={cx("font-semibold leading-snug text-ink", size === "md" ? "text-[16px]" : "text-[15px]")}>{text}</span>
        <ChevronDownIcon size={18} className={cx("mt-0.5 shrink-0 text-faint transition-transform group-hover:text-ink", open && "rotate-180")} />
        <span className="sr-only">{open ? "Hide details" : "Show details"}</span>
      </button>
    </h3>
  );
}

function Why({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
      <span className="t-kicker mr-2 text-faint">Why it may matter</span>
      {children}
    </p>
  );
}

/** Icon-only on phones to keep the footer on one line; labelled on wider screens. */
function DoneButton({ onDone, label }: { onDone: () => void; label: string }) {
  return (
    <Button size="sm" variant="secondary" onClick={onDone} aria-label={`Mark done: ${label}`} title="Mark done" className="shrink-0 max-sm:w-10 max-sm:px-0">
      <CheckIcon size={15} />
      <span className="hidden sm:inline">Done</span>
    </Button>
  );
}

/** The filing itself, one tap from the card face. */
function FilingButton({ doc }: { doc: FilingDoc }) {
  return (
    <a href={doc.url} target="_blank" rel="noopener noreferrer" aria-label={`Open the ${docLabel(doc)}: ${doc.title} (opens in a new tab)`} className={buttonClass("secondary", "sm", "shrink-0")}>
      Filing
      <ExternalIcon size={13} className="opacity-80" />
    </a>
  );
}

function Details({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  return (
    <div id={id} hidden={!open} className="mt-3.5 space-y-6 border-t border-line pt-3.5">
      {children}
    </div>
  );
}

/** The foot of an open card: on to research, or close it again without scrolling back up. */
function DetailsFooter({ symbol, company, onHide, controls }: { symbol: string; company: string; onHide: () => void; controls: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <Link href={`/research/${encodeURIComponent(symbol)}`} className="inline-flex min-h-10 items-center gap-1 text-[14px] font-medium text-accent hover:underline">
        Research {company} <ChevronIcon size={15} />
      </Link>
      <Button variant="ghost" size="sm" onClick={onHide} aria-controls={controls} className="-mr-2">
        Hide details <ChevronDownIcon size={15} className="rotate-180" />
      </Button>
    </div>
  );
}

/** Open/close state for a card; closing from the bottom brings the card's top back into view. */
function useCard() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const hide = () => {
    setOpen(false);
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "nearest" }));
  };
  return { open, toggle: () => setOpen((o) => !o), hide, ref };
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="t-kicker mb-1.5">{title}</h4>
      {children}
    </section>
  );
}

/** Source facts and FINN's interpretation are never mixed in one block. */
function Part({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-baseline gap-x-2 border-b border-line pb-1.5">
        <span className="text-[12.5px] font-semibold text-ink">{label}</span>
        <span className="t-meta">{note}</span>
      </p>
      {children}
    </div>
  );
}

function AttentionRule({ tier }: { tier: InboxItem["tier"] }) {
  if (tier !== "attention") return null;
  return <span aria-hidden="true" className="absolute inset-y-4 left-0 w-[3px] rounded-r bg-signal" />;
}

/**
 * Whether a triggered item is new to this device, and since when it has been seen. `fresh` is
 * only set once the device has history: on a first visit every alert is new, so none is marked.
 */
export type AlertMark = { fresh: boolean; firstSeenAt?: string };

/** Colour is kept for what is new since this device last looked; an alert already seen is plain. */
function AlertTag({ item, alert }: { item: InboxItem; alert?: AlertMark }) {
  if (!item.triggered) return null;
  return alert?.fresh ? (
    <Tag tone="signal" title={triggerLine(item)}>
      <BoltIcon size={12} /> New alert
    </Tag>
  ) : (
    <Tag title={triggerLine(item)}>
      <BoltIcon size={12} className="text-signal" /> Alert
    </Tag>
  );
}

/** A plain warning on the card face when FINN is not sure. The score itself is in the details. */
function ConfidenceNote({ item }: { item: InboxItem }) {
  const c = item.materiality.confidence;
  if (c.level === "high") return null;
  return (
    <span className="t-meta text-warn" title={c.reasons.join("; ")}>
      {c.level === "low" ? "Low" : "Medium"} confidence
    </span>
  );
}

/** Live and freshly cached items share the inbox's status; anything archived, stale or replayed says so itself. */
function NotLiveBadge({ item, archive }: { item: InboxItem; archive?: boolean }) {
  if (item.provenance === "live" || item.provenance === "cache") return null;
  return <ProvenanceBadge provenance={item.provenance} asOf={item.asOf} archive={archive} />;
}

const FEATURE_LABEL: Record<ScoreComponent["feature"], string> = {
  category: "Kind",
  magnitude: "Size",
  recency: "Recency",
  novelty: "Novelty",
  relevance: "Relevance",
  confidence: "Confidence",
};

function ScoreBreakdown({ item }: { item: InboxItem }) {
  const { components, confidence } = item.materiality;
  return (
    <div>
      <ul className="space-y-1.5 text-[13.5px]">
        {components.map((c, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <span className="text-muted">{FEATURE_LABEL[c.feature]} · </span>
              {c.label}
            </span>
            <span className={cx("num shrink-0", c.feature !== "category" && c.points > 0 && "text-up", c.points < 0 && "text-down")}>
              {c.feature === "category" ? c.points : `${c.points > 0 ? "+" : c.points < 0 ? "−" : "±"}${Math.abs(c.points)}`}
            </span>
          </li>
        ))}
        <li className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5 font-medium">
          <span>
            Priority score <span className="font-normal text-muted">· {TIER_LABEL[item.tier]}</span>
          </span>
          <span className="num">{item.score}</span>
        </li>
      </ul>
      <p className="t-meta mt-1.5">
        Confidence {confidence.level}: {confidence.reasons.join("; ")}. The score is the sum of the points above; it only orders what to read first and is not advice.
      </p>
    </div>
  );
}

function AlertLine({ item, alert }: { item: InboxItem; alert?: AlertMark }) {
  if (!item.triggered) return null;
  return (
    <DetailBlock title="Alert">
      <p className="text-[14px] text-ink">{triggerLine(item)}.</p>
      <p className="t-meta mt-0.5">
        {alert?.fresh ? "New on this device" : alert?.firstSeenAt ? `First seen on this device ${dateTime(alert.firstSeenAt)}` : "Shown in FINN only"} · one alert per{" "}
        {item.kind === "market" ? "company and session" : "company and event"}; FINN does not send notifications.
      </p>
    </DetailBlock>
  );
}

export function FilingRow({ item, onDone, alert }: { item: FilingItem; onDone: () => void; alert?: AlertMark }) {
  const { open, toggle, hide, ref } = useCard();
  const detailsId = useId();
  const results = useResults(item.results ? { symbol: item.symbol, periodEnd: item.results.periodEnd } : null, item.results?.attached);
  const why = (item.results && resultsWhy(results)) || item.why;
  const details = item.xbrl?.details;

  return (
    <li ref={ref} className="relative scroll-mt-20 px-4 py-4 sm:px-5">
      <AttentionRule tier={item.tier} />
      <ItemMeta symbol={item.symbol} company={item.companyName}>
        <RelativeTime iso={item.ts} />
      </ItemMeta>
      <Headline text={item.headline} open={open} onToggle={toggle} controls={detailsId} />
      {why && <Why>{why}</Why>}
      {!why && item.summary && item.tier !== "routine" && <p className="mt-1.5 line-clamp-2 text-[14px] leading-relaxed text-muted">{item.summary}</p>}

      <div className="mt-3 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Tag>{CATEGORY_LABEL[item.category]}</Tag>
          <AlertTag item={item} alert={alert} />
          <ConfidenceNote item={item} />
          <NotLiveBadge item={item} archive={item.via === "archive" || item.via === "screener"} />
        </div>
        <FilingButton doc={item.primary} />
        <DoneButton onDone={onDone} label={`${item.symbol} ${item.headline}`} />
      </div>

      <Details id={detailsId} open={open}>
        <Part label="From the filing" note={`what ${item.companyName} and the exchange published`}>
          {item.summary && (
            <DetailBlock title="Exchange description">
              <p className="text-[14px] leading-relaxed text-ink">{item.summary}</p>
            </DetailBlock>
          )}
          {results && (
            <DetailBlock title="Headline numbers">
              <ResultsTable state={results} filingUrl={item.primary.url} />
            </DetailBlock>
          )}
          {item.facts.length > 0 && (
            <DetailBlock title="Stated in the filing">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[14px]">
                {item.facts.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-muted">{f.label}</dt>
                    <dd className="font-medium text-ink">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </DetailBlock>
          )}
          {details?.kind === "management" && details.people.length > 0 && (
            <DetailBlock title="People">
              <PeoplePanel people={details.people} company={item.companyName} />
            </DetailBlock>
          )}
          {details?.kind === "deal" && details.deal.background && (
            <DetailBlock title="Background">
              <p className="text-[14px] leading-relaxed text-ink">{details.deal.background}</p>
            </DetailBlock>
          )}
          <DetailBlock title={item.related.length ? `Documents (${item.related.length + 1})` : "Document"}>
            <ul className="space-y-1.5 text-[14px]">
              {[item.primary, ...item.related].map((d) => (
                <li key={d.url} className="flex items-baseline justify-between gap-3">
                  <SourceLink href={d.url} className="-my-1 min-w-0 truncate py-1">
                    {d.title}
                  </SourceLink>
                  <span className="t-meta shrink-0">
                    {docLabel(d)} · {clock(d.ts)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="t-meta mt-1">{sourceSentence(item)}</p>
          </DetailBlock>
        </Part>

        <Part label="FINN's reading" note="interpretation — check it against the filing">
          <DetailBlock title="Classified as">
            <p className="text-[14px] text-ink">
              {CATEGORY_LABEL[item.category]} — {item.reasons.filter((r) => r !== "On your alert list").join(" · ")}
            </p>
          </DetailBlock>
          <AlertLine item={item} alert={alert} />
          <DetailBlock title="How FINN ranked this">
            <ScoreBreakdown item={item} />
          </DetailBlock>
        </Part>

        <DetailsFooter symbol={item.symbol} company={item.companyName} onHide={hide} controls={detailsId} />
      </Details>
    </li>
  );
}

const EXPLAINED = "A filing may explain it: ";

/**
 * A price or volume rule that fired, as one compact row: what fired, the move and its shape.
 * The rule arithmetic, the source and the ranking open on tap.
 */
export function MarketRow({ item, onDone, alert }: { item: MarketItem; onDone: () => void; alert?: AlertMark }) {
  const { open, toggle, hide, ref } = useCard();
  const detailsId = useId();
  const s = item.signal;
  const explained = item.materiality.components.find((c) => c.feature === "relevance" && c.label.startsWith(EXPLAINED))?.label.slice(EXPLAINED.length);
  return (
    <li ref={ref} className="relative scroll-mt-20 px-4 py-3 sm:px-5">
      <ItemMeta symbol={item.symbol} company={item.companyName}>
        {alert?.fresh && <Tag tone="signal">New</Tag>}
        <time dateTime={item.ts}>{shortDate(s.date)} close</time>
      </ItemMeta>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Headline text={item.headline} open={open} onToggle={toggle} controls={detailsId} size="sm" />
          {item.materiality.confidence.level !== "high" && (
            <p className="mt-0.5">
              <ConfidenceNote item={item} />
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <Pct value={s.changePct} className="text-[15px] font-semibold" />
          <Sparkline values={s.spark} width={56} height={18} label={`${item.symbol}, last ${s.spark.length} sessions`} />
        </div>
        <DoneButton onDone={onDone} label={`${item.symbol} ${item.headline}`} />
      </div>
      {explained && (
        <p className="mt-1 text-[13px] text-muted">
          <span className="sr-only">FINN: </span>A filing may explain it — {explained}
        </p>
      )}
      <Details id={detailsId} open={open}>
        <Part label="From the source" note="end-of-day prices and volumes">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-4">
            <div>
              <dt className="t-meta">Close</dt>
              <dd className="num font-medium">₹{formatCrore(s.close, 2)}</dd>
            </div>
            <div>
              <dt className="t-meta">Previous close</dt>
              <dd className="num font-medium">{s.prevClose == null ? "—" : `₹${formatCrore(s.prevClose, 2)}`}</dd>
            </div>
            <div>
              <dt className="t-meta">Volume</dt>
              <dd className="num font-medium">{s.volume == null ? "—" : s.volume.toLocaleString("en-IN")}</dd>
            </div>
            <div>
              <dt className="t-meta">Average volume</dt>
              <dd className="num font-medium">{s.avgVolume == null ? "—" : Math.round(s.avgVolume).toLocaleString("en-IN")}</dd>
            </div>
          </dl>
          <p className="t-meta">
            End-of-day data from {priceSourceName(item.priceSource.label)} for the session of {shortDate(s.date)} ({item.priceSource.adjustment === "as-traded" ? "as-traded prices" : "split-adjusted closes"}),{" "}
            {item.provenance === "demo" ? "replayed from FINN's capture of" : "fetched"} {dateTime(item.asOf)}.
            {s.excludedPartialSession && " Today's session is still trading, so it is excluded until it closes."}
          </p>
        </Part>
        <Part label="FINN's reading" note="your rules, applied by FINN">
          <DetailBlock title="Why it may matter">
            <p className="text-[14px] text-ink">{item.why}</p>
          </DetailBlock>
          <DetailBlock title="Rules that fired">
            <ul className="space-y-1 text-[14px]">
              {s.hits.map((h) => (
                <li key={h.id} className="flex items-center gap-1.5">
                  <BoltIcon size={13} className="text-signal" /> {h.label}
                </li>
              ))}
            </ul>
          </DetailBlock>
          <AlertLine item={item} alert={alert} />
          <DetailBlock title="How FINN ranked this">
            <ScoreBreakdown item={item} />
          </DetailBlock>
        </Part>
        <DetailsFooter symbol={item.symbol} company={item.companyName} onHide={hide} controls={detailsId} />
      </Details>
    </li>
  );
}

/** One line per routine filing: available, never in the way. */
export function RoutineRow({ item }: { item: FilingItem }) {
  return (
    <li className="flex items-baseline gap-3 px-4 py-2.5 text-[14px] sm:px-5">
      <span className="num w-24 shrink-0 truncate text-[13px] font-semibold text-muted">{item.symbol}</span>
      <a href={item.primary.url} target="_blank" rel="noopener noreferrer" className="-my-2.5 min-w-0 flex-1 truncate py-2.5 text-ink hover:text-accent hover:underline">
        {item.headline}
        <span className="sr-only"> (opens the filing in a new tab)</span>
      </a>
      <RelativeTime iso={item.ts} className="t-meta shrink-0" />
    </li>
  );
}

export function DoneRow({ item, onUndo }: { item: InboxItem; onUndo: () => void }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-[14px] sm:px-5">
      <span className="num w-24 shrink-0 truncate text-[13px] font-semibold text-muted">{item.symbol}</span>
      <span className="min-w-0 flex-1 truncate text-muted line-through decoration-line-strong">{item.headline}</span>
      <Button variant="ghost" size="sm" onClick={onUndo} aria-label={`Undo done: ${item.symbol} ${item.headline}`} className="-mr-2 shrink-0">
        <UndoIcon size={14} /> Undo
      </Button>
    </li>
  );
}
