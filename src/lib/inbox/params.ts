import { DEFAULT_ALERT_CATEGORIES, isCategory, type Category } from "@/lib/domain/categories";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@/lib/domain/signals";
import { normalizeTicker } from "@/lib/domain/ticker";
import { MAX_PORTFOLIO } from "@/lib/portfolio";
import { WINDOWS, type WindowKey } from "@/lib/inbox/types";

/** Query-string contract for /api/inbox, shared by the route and the client. */

export type InboxQuery = {
  symbols: string[];
  windowKey: WindowKey;
  thresholds: Thresholds;
  alertCategories: Category[];
};

function clampNumber(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function parseInboxQuery(sp: URLSearchParams): InboxQuery {
  const symbols = [
    ...new Set(
      (sp.get("symbols") ?? "")
        .split(",")
        .map((s) => normalizeTicker(s))
        .flatMap((r) => (r.ok ? [r.symbol] : [])),
    ),
  ].slice(0, MAX_PORTFOLIO);
  const w = sp.get("window") ?? "24h";
  const windowKey = (w in WINDOWS ? w : "24h") as WindowKey;
  const alerts = sp.get("alerts");
  return {
    symbols,
    windowKey,
    thresholds: {
      pricePct: clampNumber(sp.get("price"), 0.5, 50, DEFAULT_THRESHOLDS.pricePct),
      volumeMultiple: clampNumber(sp.get("volume"), 1.1, 20, DEFAULT_THRESHOLDS.volumeMultiple),
      lookback: Math.round(clampNumber(sp.get("lookback"), 5, 60, DEFAULT_THRESHOLDS.lookback)),
    },
    alertCategories: alerts == null ? DEFAULT_ALERT_CATEGORIES : alerts.split(",").filter(isCategory),
  };
}

export function inboxQueryString(q: InboxQuery): string {
  const sp = new URLSearchParams({
    symbols: q.symbols.join(","),
    window: q.windowKey,
    price: String(q.thresholds.pricePct),
    volume: String(q.thresholds.volumeMultiple),
    lookback: String(q.thresholds.lookback),
    alerts: q.alertCategories.join(","),
  });
  return sp.toString();
}
