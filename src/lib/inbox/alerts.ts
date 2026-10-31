import { CATEGORY_LABEL } from "@/lib/domain/categories";
import type { InboxItem } from "@/lib/inbox/types";

/**
 * The in-app alert feed. An alert is an inbox item that one of the investor's own rules
 * triggered: a material filing in a category on their alert list, or an end-of-day price or
 * volume rule. Each has one stable key — company + event (results are keyed by quarter, other
 * filings by day) or company + session for price rules — so the same event never alerts twice.
 * Pure functions; the browser keeps the log (src/components/inbox/use-alert-log.ts).
 */

export type AlertLog = Record<string, { firstSeenAt: string }>;

/** Alerts older than this drop out of the log (and could alert again only if re-filed). */
export const ALERT_LOG_TTL_MS = 45 * 86_400_000;

export function alertItems(items: InboxItem[]): InboxItem[] {
  const seen = new Set<string>();
  return items.filter((i) => i.triggered && !seen.has(i.id) && seen.add(i.id));
}

/**
 * Records this response's alerts. Returns the pruned, updated log and the keys seen for the
 * first time — the ones to mark "new". A key already in the log is never new again.
 */
export function mergeAlertLog(log: AlertLog, alertIds: readonly string[], now: number): { log: AlertLog; fresh: Set<string> } {
  const next: AlertLog = {};
  for (const [key, entry] of Object.entries(log)) {
    const t = Date.parse(entry.firstSeenAt);
    if (Number.isFinite(t) && now - t < ALERT_LOG_TTL_MS) next[key] = entry;
  }
  const fresh = new Set<string>();
  for (const id of alertIds) {
    if (next[id]) continue;
    next[id] = { firstSeenAt: new Date(now).toISOString() };
    fresh.add(id);
  }
  return { log: next, fresh };
}

/** What fired, in words, for the alert's trigger line. */
export function triggerLine(item: InboxItem): string {
  if (item.kind === "market") return `Your rule fired: ${item.reasons.join("; ")}`;
  return `${CATEGORY_LABEL[item.category]} is on your alert list, and this filing is material (score ${item.score})`;
}
