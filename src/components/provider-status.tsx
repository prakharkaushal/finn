"use client";

import { useState } from "react";
import type { ProbeReport } from "@/lib/data/probe";
import type { ProviderHealth } from "@/lib/data/schema";
import { clock } from "@/lib/format";
import { CheckIcon } from "@/components/icons";
import { Button, cx, ProvenanceDot, type DisplayProvenance } from "@/components/ui";

/** Provider health and the on-demand live check: the place to diagnose a failing source. */

const TONE: Record<Exclude<ProviderHealth["status"], "idle">, DisplayProvenance> = { ok: "live", degraded: "stale", down: "error" };
const LABEL: Record<ProviderHealth["status"], string> = { ok: "Working", degraded: "Degraded", down: "Down", idle: "Not used yet" };
const KIND: Record<ProviderHealth["kind"], string> = { prices: "Prices", announcements: "Filings", fundamentals: "Statements", documents: "Documents", directory: "Directory" };

function ProbeResults({ report }: { report: ProbeReport }) {
  const passed = report.rows.filter((r) => r.ok).length;
  return (
    <div className="mt-3">
      <p className="text-[13.5px] font-medium">
        {passed} of {report.rows.length} checks passed <span className="t-meta">· {report.mode} · {clock(report.startedAt)}</span>
      </p>
      <ul className="mt-2 space-y-2">
        {report.rows.map((r, i) => (
          <li key={i} className="flex gap-2.5 text-[13.5px]">
            <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full", r.ok ? "bg-up-soft text-up" : "bg-down-soft text-down")} aria-hidden="true">
              {r.ok ? <CheckIcon size={11} /> : "!"}
            </span>
            <span className="min-w-0">
              <span className="sr-only">{r.ok ? "Passed: " : "Failed: "}</span>
              <span className="font-medium">{r.sample}</span> <span className="t-meta">· {r.provider} · {r.ms} ms</span>
              <span className={cx("block break-words", r.ok ? "text-muted" : "text-down")}>{r.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProviderStatus({ providers, dataMode }: { providers: ProviderHealth[]; dataMode: "live" | "demo" }) {
  const [probe, setProbe] = useState<{ state: "idle" | "running" } | { state: "done"; report: ProbeReport } | { state: "error"; error: string }>({ state: "idle" });

  const run = async () => {
    setProbe({ state: "running" });
    try {
      const res = await fetch("/api/status?probe=1");
      const body = (await res.json()) as { probe?: ProbeReport | null };
      if (!res.ok || !body.probe) throw new Error(`The server answered ${res.status}`);
      setProbe({ state: "done", report: body.probe });
    } catch (err) {
      setProbe({ state: "error", error: err instanceof Error ? err.message : "The check failed" });
    }
  };

  return (
    <div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {providers.map((p) => (
          <li key={p.id} className="px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-1.5 text-[14px] font-medium">
                {p.status === "idle" ? (
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full border border-line-strong" aria-hidden="true" />
                ) : (
                  <ProvenanceDot provenance={TONE[p.status]} />
                )}
                <span className="min-w-0">{p.label}</span>
              </span>
              <span className="t-meta shrink-0">{LABEL[p.status]}</span>
            </div>
            <p className="t-meta mt-0.5">
              {[KIND[p.kind], `${p.calls} call${p.calls === 1 ? "" : "s"}`, p.failures ? `${p.failures} failed` : null, p.lastSuccessAt ? `last ok ${clock(p.lastSuccessAt)}` : null, p.lastLatencyMs != null ? `${p.lastLatencyMs} ms` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {p.status === "down" && p.lastError && <p className="mt-1 break-words text-[13px] text-down">{p.lastError}</p>}
            {p.degradedBecause && <p className="mt-1 text-[13px] text-warn">{p.degradedBecause}</p>}
            {p.issues.length > 0 && (
              <p className="mt-1 text-[12.5px] text-muted">
                Recent extraction issue: {p.issues[0].subject} — {p.issues[0].message}
                {p.issues.length > 1 ? ` (+${p.issues.length - 1} more)` : ""}
              </p>
            )}
            {p.note && <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{p.note}</p>}
          </li>
        ))}
      </ul>
      <p className="t-meta mt-2">Counts cover this server process since it started.</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button size="sm" onClick={run} disabled={probe.state === "running"} aria-busy={probe.state === "running"}>
          {probe.state === "running" ? "Checking sources…" : dataMode === "demo" ? "Check the demo dataset" : "Run a live check"}
        </Button>
        <span className="t-meta">{dataMode === "demo" ? "Reads the committed dataset only." : "About a dozen small live requests; a result is reused for two minutes."}</span>
      </div>
      <div aria-live="polite">
        {probe.state === "done" && <ProbeResults report={probe.report} />}
        {probe.state === "error" && <p className="mt-2 text-[13px] text-down">{probe.error}</p>}
      </div>
    </div>
  );
}
