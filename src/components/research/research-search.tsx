"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { instrumentSlug, parseInstrument } from "@/lib/data/instrument";
import { RESEARCH_PICKS } from "@/lib/portfolio";
import { useSettings } from "@/components/settings-provider";
import { SearchIcon } from "@/components/icons";
import { PageFrame } from "@/components/shell";
import { Button, cx, SectionHeading, Tag } from "@/components/ui";

type Hit = { symbol: string; name: string };

const PICKS: Record<string, { name: string; note: string }> = {
  PIDILITIND: { name: "Pidilite Industries", note: "Adhesives & sealants" },
  KAYNES: { name: "Kaynes Technology", note: "Electronics manufacturing" },
  ASIANPAINT: { name: "Asian Paints", note: "Paints" },
  COFORGE: { name: "Coforge", note: "IT services" },
};

export function ResearchSearch() {
  const router = useRouter();
  const { settings } = useSettings();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [precomputed, setPrecomputed] = useState<Set<string> | null>(null);
  const listId = useId();
  const hintId = useId();

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((s: { precomputedResearch?: { symbol: string }[] }) => setPrecomputed(new Set((s.precomputedResearch ?? []).map((r) => r.symbol))))
      .catch(() => setPrecomputed(new Set()));
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/tickers?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((body: { results?: Hit[]; error?: string }) => {
          setHits(body.results ?? []);
          setSearched(term);
          setActive(0);
          if (body.error) setError(body.error);
        })
        .catch(() => {});
    }, 160);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = (symbol: string) => router.push(`/research/${encodeURIComponent(symbol)}`);
  const showList = q.trim().length > 0 && searched === q.trim();

  const submit = () => {
    // An explicit BSE listing ("TCS.BO", "BSE:TCS") is honoured over the NSE-name suggestions.
    const explicitBse = /\.(BO|BSE)\s*$|^\s*BSE\s*:/i.test(q);
    if (showList && hits[active] && !explicitBse) return go(hits[active].symbol);
    const t = parseInstrument(q);
    if (!t.ok) return setError(t.error);
    go(instrumentSlug(t.instrument));
  };

  return (
    <PageFrame narrow>
      <p className="t-kicker">Research · Pull</p>
      <h1 className="t-display mt-2 lg:text-[38px]">Research a company</h1>
      <p className="mt-2.5 max-w-xl text-[15px] leading-relaxed text-muted">
        Any NSE-listed company. FINN reads its own documents — the latest annual report, the last four earnings-call transcripts, the latest results filing and
        presentation — then checks what management promised against what it reported. Every claim links to the page it rests on.
      </p>

      <form
        className="relative mt-6"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="ticker" className="t-kicker mb-2 block">
          NSE ticker or company name
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              id="ticker"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setError(null);
                if (!e.target.value.trim()) setHits([]);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, hits.length - 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                }
                if (e.key === "Escape") setHits([]);
              }}
              placeholder="e.g. TITAN or Pidilite"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showList && hits.length > 0}
              aria-controls={listId}
              aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
              aria-describedby={hintId}
              className="h-12 w-full rounded-lg border border-line-strong bg-surface pl-10 pr-3 text-[16px] outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
          <Button type="submit" variant="primary" className="h-12" disabled={!q.trim()}>
            Research
          </Button>
        </div>
        <p id={hintId} className="t-meta mt-2">
          Checked against NSE&apos;s own equity list. Add .BO (e.g. TCS.BO) to price the BSE listing instead.
        </p>
        {showList && (
          <ul id={listId} role="listbox" aria-label="Matching companies" className="absolute inset-x-0 top-[86px] z-10 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
            {hits.length ? (
              hits.map((h, i) => (
                <li key={h.symbol} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => go(h.symbol)}
                    onMouseEnter={() => setActive(i)}
                    className={cx("flex min-h-11 w-full items-baseline gap-3 px-4 py-2.5 text-left", i === active && "bg-surface-2")}
                  >
                    <span className="num w-28 shrink-0 text-[14px] font-semibold">{h.symbol}</span>
                    <span className="truncate text-[14px] text-muted">{h.name}</span>
                  </button>
                </li>
              ))
            ) : (
              <li role="option" aria-selected={false} aria-disabled="true" className="px-4 py-3 text-[14px] text-muted">
                No NSE company matches “{searched}”.
              </li>
            )}
          </ul>
        )}
      </form>
      {error && (
        <p role="alert" className="mt-2 text-[14px] text-down">
          {error}
        </p>
      )}

      <section className="mt-10" aria-labelledby="picks-heading">
        <SectionHeading id="picks-heading" title="Start with these" hint="Companies with a clear guidance track record to check" />
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {RESEARCH_PICKS.map((s) => {
            const ready = precomputed?.has(s);
            return (
              <li key={s}>
                <Link href={`/research/${s}`} className="flex min-h-16 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 hover:border-line-strong">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{PICKS[s]?.name ?? s}</span>
                    <span className="block text-[13px] text-muted">
                      <span className="num">{s}</span> · {PICKS[s]?.note}
                    </span>
                  </span>
                  {precomputed && (
                    <Tag tone={ready ? "warn" : "neutral"} title={ready ? "A precomputed snapshot opens instantly; you can rebuild it live" : "Built live from sources in a few seconds"}>
                      {ready ? "Snapshot" : "Live"}
                    </Tag>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {settings.portfolio.length > 0 && (
        <section className="mt-10" aria-labelledby="portfolio-heading">
          <SectionHeading id="portfolio-heading" title="From your portfolio" count={settings.portfolio.length} />
          <ul className="flex flex-wrap gap-2">
            {settings.portfolio.map((s) => (
              <li key={s}>
                <Link href={`/research/${encodeURIComponent(s)}`} className="num inline-flex min-h-9 items-center rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-muted hover:border-line-strong hover:text-ink">
                  {s}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageFrame>
  );
}
