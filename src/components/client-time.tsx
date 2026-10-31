"use client";

import { useSyncExternalStore } from "react";
import { clock, dateTime, shortDate, timeAgo, todayLabel } from "@/lib/format";

// The current time must not be read during prerender (it would be frozen into the static
// shell), so it is only taken on the client. The snapshot changes at most once a minute.
let minute = 0;
function getNow() {
  const n = Math.floor(Date.now() / 60_000) * 60_000;
  if (n !== minute) minute = n;
  return minute;
}
const noopSubscribe = () => () => {};

export function useClientNow(): number | null {
  return useSyncExternalStore(noopSubscribe, getNow, () => null);
}

export function TodayLabel({ className }: { className?: string }) {
  const now = useClientNow();
  return <span className={className}>{now ? todayLabel(now) : ""}</span>;
}

/** "2h ago" / "Yesterday 21:30" on the client; the absolute IST time while prerendering. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useClientNow();
  return (
    <time dateTime={iso} title={dateTime(iso)} className={className}>
      {now ? timeAgo(iso, now) : `${shortDate(iso)}, ${clock(iso)}`}
    </time>
  );
}
