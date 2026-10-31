"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DATA_COOKIE } from "@/lib/data/mode";
import { cx } from "@/components/ui";

/**
 * Which data this visit is using. Asked of the server (/api/status), so the label can never
 * disagree with what the APIs serve. One request per page load, shared by every caller.
 */
export type DataModeStatus = { dataMode: "live" | "demo"; demoForced: boolean; capturedAt: string | null };

let request: Promise<DataModeStatus | null> | null = null;

function load(): Promise<DataModeStatus | null> {
  request ??= fetch("/api/status")
    .then((r) => (r.ok ? r.json() : null))
    .then((s: { dataMode?: string; demoForced?: boolean; demo?: { capturedAt: string | null } | null } | null) =>
      s ? { dataMode: s.dataMode === "demo" ? ("demo" as const) : ("live" as const), demoForced: Boolean(s.demoForced), capturedAt: s.demo?.capturedAt ?? null } : null,
    )
    .catch(() => null);
  return request;
}

export function useDataMode(): DataModeStatus | null {
  const [status, setStatus] = useState<DataModeStatus | null>(null);
  useEffect(() => {
    let current = true;
    load().then((s) => current && setStatus(s));
    return () => {
      current = false;
    };
  }, []);
  return status;
}

/** Switch this browser to demo or live data, then reload so every screen re-reads its data. */
export function switchDataMode(mode: "live" | "demo") {
  document.cookie = `${DATA_COOKIE}=${mode}; path=/; max-age=${30 * 86_400}; samesite=lax`;
  window.location.reload();
}

/** The header's standing label: Live data or Demo data, linking to where it is changed. */
export function DataModeBadge() {
  const status = useDataMode();
  if (!status) return null;
  const demo = status.dataMode === "demo";
  return (
    <Link
      href="/settings#data"
      title={demo ? "Demo data: replayed from FINN's committed capture, not live. Change it in Settings." : "Live data: fetched from the sources as you load each screen. Change it in Settings."}
      className={cx(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium",
        demo ? "border-sample/40 bg-sample-soft text-sample" : "border-line-strong text-muted hover:text-ink",
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", demo ? "bg-sample" : "bg-up")} aria-hidden="true" />
      {demo ? "Demo data" : "Live data"}
    </Link>
  );
}
