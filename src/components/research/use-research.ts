"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExtraSource } from "@/lib/research/discover";
import type { ResearchEvent, ResearchReport } from "@/lib/research/types";

export type ResearchStep = { id: string; label: string; status: "running" | "done" | "skipped" | "error"; detail?: string };

const SOURCES_KEY = "finn.research-sources.v1";

export const TRUNCATED =
  "The connection closed before the report arrived — the server may have hit its time limit. Try again: documents already read are kept, so the next attempt is quicker.";

function readSources(symbol: string): ExtraSource[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(SOURCES_KEY) ?? "{}") as Record<string, ExtraSource[]>;
    return Array.isArray(all[symbol]) ? all[symbol].slice(0, 3) : [];
  } catch {
    return [];
  }
}

function writeSources(symbol: string, list: ExtraSource[]) {
  try {
    const all = JSON.parse(window.localStorage.getItem(SOURCES_KEY) ?? "{}") as Record<string, ExtraSource[]>;
    if (list.length) all[symbol] = list;
    else delete all[symbol];
    window.localStorage.setItem(SOURCES_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the added source still applies to this visit's rebuild.
  }
}

/**
 * Reads the NDJSON research stream: step events as they happen, then the report or an error.
 * Sources the investor added for this symbol are kept on the device and sent with every build.
 */
export function useResearch(symbol: string) {
  const [steps, setSteps] = useState<ResearchStep[]>([]);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [run, setRun] = useState<{ n: number; refresh: boolean; extras: ExtraSource[] | null }>({ n: 0, refresh: false, extras: null });

  useEffect(() => {
    const ctrl = new AbortController();
    const extras = run.extras ?? readSources(symbol);
    // A new run for this symbol resets the progress shown.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setSteps([]);
    setError(null);
    if (!run.extras) setRun((r) => ({ ...r, extras }));
    const sp = new URLSearchParams();
    if (run.refresh) sp.set("refresh", "1");
    if (extras.length) sp.set("extra", JSON.stringify(extras));
    const qs = sp.toString();
    (async () => {
      try {
        const res = await fetch(`/api/research/${encodeURIComponent(symbol)}${qs ? `?${qs}` : ""}`, { signal: ctrl.signal });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Server responded ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let ended = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let event: ResearchEvent;
            try {
              event = JSON.parse(line) as ResearchEvent;
            } catch {
              throw new Error("The server sent an update FINN could not read. Try again.");
            }
            if (event.type === "step") {
              setSteps((prev) => {
                const step = { id: event.id, label: event.label, status: event.status, detail: event.detail };
                const idx = prev.findIndex((s) => s.id === event.id);
                if (idx < 0) return [...prev, step];
                const next = [...prev];
                next[idx] = step;
                return next;
              });
            } else if (event.type === "report") {
              ended = true;
              setReport(event.report);
            } else {
              ended = true;
              setError(event.message);
            }
          }
        }
        // The stream closed with neither a report nor an error: the host cut the request off (a
        // time limit) or the connection dropped. Without this the screen would wait forever.
        if (!ended) throw new Error(TRUNCATED);
      } catch (err) {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : "Research failed");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
    // `run.extras` is filled from storage on the first pass; that update must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, run.n, run.refresh]);

  const refresh = useCallback(() => setRun((r) => ({ ...r, n: r.n + 1, refresh: true })), []);
  const retry = useCallback(() => setRun((r) => ({ ...r, n: r.n + 1 })), []);
  const setExtras = useCallback(
    (next: ExtraSource[]) => {
      writeSources(symbol, next);
      setRun((r) => ({ n: r.n + 1, refresh: true, extras: next }));
    },
    [symbol],
  );
  const extras = useMemo(() => run.extras ?? [], [run.extras]);
  const addSource = useCallback((e: ExtraSource) => setExtras([...extras.filter((x) => x.url !== e.url), e].slice(0, 3)), [extras, setExtras]);
  const removeSource = useCallback((url: string) => setExtras(extras.filter((x) => x.url !== url)), [extras, setExtras]);
  return { steps, report, error, loading, refresh, retry, extras, addSource, removeSource };
}
