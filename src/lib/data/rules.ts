import { AlertRuleSchema, type AlertRule } from "@/lib/data/schema";
import { CATEGORIES, isCategory, type Category } from "@/lib/domain/categories";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@/lib/domain/signals";

/**
 * The investor's settings as canonical alert rules, and back. Every rule is validated, so an
 * out-of-range threshold is rejected here instead of silently changing what triggers.
 */

export function rulesFromSettings(t: Thresholds, alertCategories: readonly Category[]): AlertRule[] {
  const wanted = new Set(alertCategories);
  const rules: AlertRule[] = [
    { id: "price-move", kind: "price_move", enabled: true, thresholdPct: t.pricePct },
    { id: "volume-spike", kind: "volume_spike", enabled: true, multiple: t.volumeMultiple, lookbackSessions: t.lookback },
    { id: "week52", kind: "week52_extreme", enabled: true },
    ...CATEGORIES.filter((c) => c !== "unclassified").map((category) => ({
      id: `filing:${category}`,
      kind: "filing_category" as const,
      enabled: wanted.has(category),
      category,
    })),
  ];
  return rules.map((r) => AlertRuleSchema.parse(r));
}

export function thresholdsFromRules(rules: readonly AlertRule[]): Thresholds {
  const price = rules.find((r) => r.kind === "price_move");
  const volume = rules.find((r) => r.kind === "volume_spike");
  return {
    pricePct: price?.thresholdPct ?? DEFAULT_THRESHOLDS.pricePct,
    volumeMultiple: volume?.multiple ?? DEFAULT_THRESHOLDS.volumeMultiple,
    lookback: volume?.lookbackSessions ?? DEFAULT_THRESHOLDS.lookback,
  };
}

export function alertCategoriesFromRules(rules: readonly AlertRule[]): Category[] {
  return rules.flatMap((r) => (r.kind === "filing_category" && r.enabled && isCategory(r.category) ? [r.category] : []));
}
