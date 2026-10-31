"use client";

import { dateTime } from "@/lib/format";
import { switchDataMode, useDataMode } from "@/components/data-mode";

/**
 * A standing notice on every screen while this visit uses demo data — chosen in Settings, or
 * forced for the whole deployment by FINN_DATA_MODE=demo. It says when the capture was taken,
 * so replayed filings and prices are never read as today's.
 */
export function DataModeBanner() {
  const status = useDataMode();
  if (status?.dataMode !== "demo") return null;
  return (
    <div role="status" className="border-b border-sample/30 bg-sample-soft">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px] leading-snug text-ink lg:px-8">
        <p className="min-w-0 flex-1">
          <strong className="font-semibold text-sample">Demo data.</strong> Replayed from FINN&apos;s capture
          {status.capturedAt ? ` of ${dateTime(status.capturedAt)}` : ""} — real filings and prices, but not live, and nothing is fetched.
        </p>
        {!status.demoForced && (
          <button type="button" onClick={() => switchDataMode("live")} className="-my-1 min-h-9 shrink-0 rounded-md px-2 font-medium text-sample underline-offset-2 hover:underline">
            Switch to live data
          </button>
        )}
      </div>
    </div>
  );
}
