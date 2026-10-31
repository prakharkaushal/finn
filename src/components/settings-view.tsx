"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/domain/categories";
import { normalizeTicker } from "@/lib/domain/ticker";
import { dateTime } from "@/lib/format";
import { MAX_PORTFOLIO } from "@/lib/portfolio";
import type { ProviderHealth } from "@/lib/data/schema";
import { useSettings } from "@/components/settings-provider";
import { switchDataMode } from "@/components/data-mode";
import { CloseIcon } from "@/components/icons";
import { ProviderStatus } from "@/components/provider-status";
import { PageFrame } from "@/components/shell";
import { Button, cx, ProvenanceDot, SegmentedControl, Skeleton } from "@/components/ui";

type Status = {
  dataMode: "live" | "demo";
  demoForced: boolean;
  demo: { capturedAt: string | null } | null;
  providers: ProviderHealth[];
  llm: { enabled: boolean; fastModel: string; reasoningModel: string };
  archive: { updatedAt: string; items: number; pulls: number } | null;
  precomputedResearch: { symbol: string; generatedAt: string }[];
  userAgent: string;
};

function Panel({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-line bg-surface px-4 py-4 sm:px-5">
      <h2 id={id} className="text-[16px] font-semibold">
        {title}
      </h2>
      {hint && <p className="mt-0.5 text-[13.5px] text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stepper({ label, value, unit, min, max, step, onChange }: { label: string; value: number; unit: string; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const set = (v: number) => onChange(Math.round(Math.min(max, Math.max(min, v)) * 100) / 100);
  return (
    <div className="flex min-h-12 items-center justify-between gap-3" role="group" aria-label={label}>
      <span className="text-[15px]">{label}</span>
      <span className="flex items-center gap-1.5">
        <Button size="icon" className="text-[18px]" aria-label={`Decrease ${label}`} onClick={() => set(value - step)} disabled={value <= min}>
          −
        </Button>
        <output className="num w-16 text-center text-[15px] font-semibold" aria-live="polite">
          {value}
          {unit}
        </output>
        <Button size="icon" className="text-[18px]" aria-label={`Increase ${label}`} onClick={() => set(value + step)} disabled={value >= max}>
          +
        </Button>
      </span>
    </div>
  );
}

export function SettingsView() {
  const { ready, settings, update, reset } = useSettings();
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setStatus)
      .catch(() => setStatusError(true));
  }, []);

  const add = async () => {
    const t = normalizeTicker(input);
    if (!t.ok) return setMessage({ tone: "error", text: t.error });
    if (settings.portfolio.includes(t.symbol)) return setMessage({ tone: "error", text: `${t.symbol} is already in your portfolio` });
    if (settings.portfolio.length >= MAX_PORTFOLIO) return setMessage({ tone: "error", text: `Up to ${MAX_PORTFOLIO} companies` });
    setAdding(true);
    try {
      const res = await fetch(`/api/tickers?symbol=${encodeURIComponent(t.symbol)}`);
      const body = (await res.json()) as { valid?: boolean; symbol?: string; name?: string; error?: string };
      if (!body.valid) return setMessage({ tone: "error", text: body.error ?? `${t.symbol} not found on NSE` });
      update({ portfolio: [...settings.portfolio, body.symbol!] });
      setInput("");
      setMessage({ tone: "ok", text: `Added ${body.symbol} · ${body.name}` });
    } catch {
      setMessage({ tone: "error", text: "Couldn't check the symbol right now — try again in a moment" });
    } finally {
      setAdding(false);
    }
  };

  const toggle = (c: Category) =>
    update({ alertCategories: settings.alertCategories.includes(c) ? settings.alertCategories.filter((x) => x !== c) : [...settings.alertCategories, c] });

  return (
    <PageFrame narrow>
      <p className="t-kicker">Rules &amp; settings</p>
      <h1 className="t-display mt-2 lg:text-[38px]">Decide what counts as unusual</h1>
      <p className="mt-2.5 text-[15px] text-muted">Saved on this device only. FINN applies these to every refresh of your inbox.</p>

      {!ready ? (
        <div className="mt-8 space-y-4" aria-busy="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="mt-8 space-y-5">
          <Panel id="portfolio" title={`Portfolio · ${settings.portfolio.length}`} hint="Any NSE symbol, checked against NSE's equity list. Filings and price rules apply to everything here.">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <label htmlFor="add-symbol" className="sr-only">
                Add an NSE symbol
              </label>
              <input
                id="add-symbol"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Add a symbol, e.g. TITAN"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-3 text-[16px] outline-none placeholder:text-faint focus:border-accent"
              />
              <Button type="submit" variant="primary" disabled={adding || !input.trim()}>
                {adding ? "Checking…" : "Add"}
              </Button>
            </form>
            {message && (
              <p role="status" className={cx("mt-2 text-[14px]", message.tone === "ok" ? "text-up" : "text-down")}>
                {message.text}
              </p>
            )}
            <ul className="mt-4 flex flex-wrap gap-2">
              {settings.portfolio.map((s) => (
                <li key={s} className="flex items-center rounded-md border border-line bg-bg">
                  <Link href={`/research/${encodeURIComponent(s)}`} className="num flex min-h-9 items-center pl-3 pr-1 text-[13px] font-semibold hover:text-accent">
                    {s}
                  </Link>
                  <button
                    type="button"
                    aria-label={`Remove ${s} from portfolio`}
                    onClick={() => update({ portfolio: settings.portfolio.filter((x) => x !== s) })}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-faint hover:text-down"
                  >
                    <CloseIcon size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel id="rules" title="Price & volume rules" hint="Checked on each company's last completed trading session.">
            <Stepper label="Daily price move beyond ±" value={settings.thresholds.pricePct} unit="%" min={0.5} max={20} step={0.5} onChange={(v) => update({ thresholds: { ...settings.thresholds, pricePct: v } })} />
            <Stepper label="Volume above" value={settings.thresholds.volumeMultiple} unit="×" min={1.2} max={10} step={0.1} onChange={(v) => update({ thresholds: { ...settings.thresholds, volumeMultiple: v } })} />
            <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
              <span className="text-[15px]">…its average over the last</span>
              <SegmentedControl
                label="Volume average window"
                options={[10, 20, 50].map((d) => ({ value: String(d), label: `${d} days` }))}
                value={String(settings.thresholds.lookback)}
                onChange={(v) => update({ thresholds: { ...settings.thresholds, lookback: Number(v) } })}
              />
            </div>
          </Panel>

          <Panel id="categories" title="Filings that interrupt me" hint="A material filing of these types always lands in Needs attention. Routine paperwork never does.">
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.filter((c) => c !== "unclassified").map((c) => {
                const on = settings.alertCategories.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(c)}
                    className={cx(
                      "min-h-10 rounded-md border px-3 text-[13.5px] font-medium transition-colors",
                      on ? "border-signal/50 bg-signal-soft text-signal" : "border-line-strong text-muted hover:text-ink",
                    )}
                  >
                    {on ? "✓ " : ""}
                    {CATEGORY_LABEL[c]}
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel id="delivery" title="Alert delivery" hint="Where alerts reach you. Only the first is built.">
            <ul className="divide-y divide-line text-[14px]">
              {[
                { name: "In FINN", status: "On", on: true, detail: "Alerts appear in the inbox's Alerts view, marked New the first time this device sees them. One alert per company and event, or per company and session for price rules." },
                { name: "Email", status: "Not available", on: false, detail: "Not built in this prototype." },
                { name: "Phone notifications (Web Push)", status: "Not available", on: false, detail: "Not built in this prototype." },
              ].map((d) => (
                <li key={d.name} className="flex items-start justify-between gap-3 py-2.5 first:pt-0">
                  <span>
                    <span className="block font-medium">{d.name}</span>
                    <span className="block text-[13px] text-muted">{d.detail}</span>
                  </span>
                  <span className={cx("shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium", d.on ? "bg-up-soft text-up" : "bg-surface-2 text-muted")}>{d.status}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
              Sending alerts while FINN is closed needs three things this prototype does not have: a scheduled job that runs your rules after each filing pull and
              market close; somewhere to keep your rules and the alerts already sent (today both live only in this browser); and a sender — Web Push, which needs a
              service worker, server keys and your permission, or an email service. Until those exist, FINN does not claim to notify you.
            </p>
          </Panel>

          <Panel id="data" title="Data & models" hint="Where FINN's data comes from, and how each source is doing.">
            {statusError ? (
              <p className="text-[14px] text-down">Status unavailable — the server did not respond.</p>
            ) : !status ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : (
              <dl className="space-y-3 text-[14px]">
                <div>
                  <dt className="t-meta flex items-center gap-1.5">
                    <ProvenanceDot provenance={status.dataMode === "demo" ? "demo" : "live"} /> Data mode
                  </dt>
                  <dd className="mt-0.5">
                    {status.dataMode === "demo"
                      ? `Demo — every screen replays FINN's committed capture${status.demo?.capturedAt ? ` of ${dateTime(status.demo.capturedAt)}` : ""}; nothing is fetched.`
                      : "Live — each kind of data is read from the sources below, in order, falling back to the committed snapshot (labelled) only when they fail."}
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <SegmentedControl
                        label="Data mode for this browser"
                        options={[
                          { value: "live", label: "Live data", title: "Fetch from NSE, Yahoo Finance and screener.in" },
                          { value: "demo", label: "Demo data", title: "Replay the committed capture; works when a source is rate-limited" },
                        ]}
                        value={status.dataMode}
                        onChange={(m) => m !== status.dataMode && !status.demoForced && switchDataMode(m)}
                      />
                      <span className="t-meta">
                        {status.demoForced
                          ? "This deployment serves demo data only (FINN_DATA_MODE=demo)."
                          : "For this browser only. Demo data still works when a live source is rate-limited or down."}
                      </span>
                    </div>
                  </dd>
                </div>
                <div>
                  <dt className="t-meta mb-1.5">Data providers</dt>
                  <dd>
                    <ProviderStatus providers={status.providers} dataMode={status.dataMode} />
                  </dd>
                </div>
                <div>
                  <dt className="t-meta flex items-center gap-1.5">
                    <ProvenanceDot provenance={status.llm.enabled ? "live" : "error"} /> LLM
                  </dt>
                  <dd className="mt-0.5">
                    {status.llm.enabled
                      ? `On — ${status.llm.fastModel} structures guidance the rules miss; ${status.llm.reasoningModel} writes the cited bull/bear.`
                      : "Off — no API key on this server. Everything except the bull/bear synthesis works without it."}
                  </dd>
                </div>
                <div>
                  <dt className="t-meta flex items-center gap-1.5">
                    <ProvenanceDot provenance={status.archive ? "snapshot" : "error"} /> Filings archive
                  </dt>
                  <dd className="mt-0.5">
                    {status.archive ? `${status.archive.items} filings from ${status.archive.pulls} feed pulls, last captured ${dateTime(status.archive.updatedAt)}` : "None yet — run npm run snapshot"}
                  </dd>
                </div>
                <div>
                  <dt className="t-meta flex items-center gap-1.5">
                    <ProvenanceDot provenance={status.precomputedResearch.length ? "snapshot" : "live"} /> Precomputed research
                  </dt>
                  <dd className="mt-0.5">
                    {status.precomputedResearch.length
                      ? status.precomputedResearch.map((r) => `${r.symbol} (${dateTime(r.generatedAt)})`).join(", ")
                      : "None — every report is built live"}
                  </dd>
                </div>
                <div>
                  <dt className="t-meta">Identifies itself to sources as</dt>
                  <dd className="num mt-0.5 break-words text-[13px]">{status.userAgent}</dd>
                </div>
              </dl>
            )}
          </Panel>

          <div className="pt-2">
            {confirmReset ? (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm reset">
                <span className="text-[14px]">Replace your portfolio and rules with the demo defaults?</span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    reset();
                    setConfirmReset(false);
                    setMessage({ tone: "ok", text: "Reset to the demo portfolio and default rules" });
                  }}
                >
                  Yes, reset
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" className="-ml-3" onClick={() => setConfirmReset(true)}>
                Reset to the demo portfolio and default rules…
              </Button>
            )}
          </div>
        </div>
      )}
    </PageFrame>
  );
}
