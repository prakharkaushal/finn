import { CATEGORY_LABEL, type Category, type Tier } from "@/lib/domain/categories";
import type { Classification } from "@/lib/domain/classify";
import { formatCroreInr, formatPct, type Change } from "@/lib/domain/numbers";
import type { ResultsSnapshot } from "@/lib/domain/results";
import type { MarketSignal, Thresholds } from "@/lib/domain/signals";

/**
 * A transparent materiality score: the sum of named, bounded components, each with a reason
 * the investor can read on the card.
 *   category   — what kind of event it is (the classification rule's weight, 0–100)
 *   magnitude  — how big it is for this company (results swing, order or deal size vs revenue,
 *                dilution, how far past your price/volume rule)
 *   recency    — how fresh it is within the window
 *   novelty    — first of its kind in the window, or a follow-up
 *   relevance  — your own alert list; a price/volume move in the same company
 *   confidence — how sure FINN is of the classification and the data behind it
 * No model is involved, and nothing here is advice: it orders what to read first.
 */

export type Feature = "category" | "magnitude" | "recency" | "novelty" | "relevance" | "confidence";
export type ScoreComponent = { feature: Feature; points: number; label: string };
export type Confidence = { level: "high" | "medium" | "low"; reasons: string[] };
export type Materiality = { score: number; tier: Tier; triggered: boolean; components: ScoreComponent[]; confidence: Confidence };
export type Magnitude = { points: number; label: string };

/** Below this category weight a filing is paperwork: it never triggers an alert, even in a watched category. */
export const TRIGGER_FLOOR = 40;

const CONFIDENCE_POINTS: Record<Confidence["level"], number> = { high: 0, medium: -3, low: -8 };

function tierFor(score: number, triggered: boolean): Tier {
  return triggered || score >= 70 ? "attention" : score >= 30 ? "look" : "routine";
}

export function recencyComponent(ageHours: number): ScoreComponent | null {
  if (ageHours <= 6) return { feature: "recency", points: 4, label: "Filed in the last 6 hours" };
  if (ageHours <= 24) return { feature: "recency", points: 2, label: "Filed in the last day" };
  if (ageHours > 24 * 7) return { feature: "recency", points: -6, label: `Filed ${Math.round(ageHours / 24)} days ago` };
  if (ageHours > 72) return { feature: "recency", points: -3, label: `Filed ${Math.round(ageHours / 24)} days ago` };
  return null;
}

function confidenceComponent(c: Confidence): ScoreComponent | null {
  const points = CONFIDENCE_POINTS[c.level];
  return points ? { feature: "confidence", points, label: `${c.level === "low" ? "Low" : "Medium"} confidence: ${c.reasons[0] ?? "see the filing"}` } : null;
}

/** The plain sum of the listed points (never below zero). Not capped: a cap would hide the differences the score exists to show. */
function total(components: ScoreComponent[]): number {
  return Math.round(Math.max(0, components.reduce((s, c) => s + c.points, 0)));
}

export type FilingMaterialityInput = {
  classification: Pick<Classification, "category" | "subtype" | "score" | "reasons">;
  magnitude?: Magnitude | null;
  ageHours: number;
  /** An earlier filing of the same kind for this company in the window. */
  followUp?: boolean;
  /** The investor's own alert list contains this category. */
  onAlertList: boolean;
  /** A price/volume rule fired for the same company around this filing. */
  corroboration?: string | null;
  confidence: Confidence;
};

export function filingMateriality(input: FilingMaterialityInput): Materiality {
  const c = input.classification;
  const components: ScoreComponent[] = [{ feature: "category", points: c.score, label: c.reasons[0] ?? CATEGORY_LABEL[c.category] }];
  if (input.magnitude) components.push({ feature: "magnitude", ...input.magnitude });
  const recency = recencyComponent(input.ageHours);
  if (recency) components.push(recency);
  if (input.followUp) components.push({ feature: "novelty", points: -6, label: "Follow-up to an earlier filing of the same kind in this window" });
  const triggered = input.onAlertList && c.score >= TRIGGER_FLOOR;
  if (triggered) components.push({ feature: "relevance", points: 10, label: `On your alert list (${CATEGORY_LABEL[c.category as Category]})` });
  if (input.corroboration) components.push({ feature: "relevance", points: 5, label: input.corroboration });
  const conf = confidenceComponent(input.confidence);
  if (conf) components.push(conf);
  const score = total(components);
  return { score, tier: tierFor(score, triggered), triggered, components, confidence: input.confidence };
}

/** A price/volume alert: your rule fired, scored by how far past the rule the move went. */
export function marketMateriality(s: MarketSignal, t: Thresholds, opts: { ageHours: number; corroboration?: string | null; confidence: Confidence }): Materiality {
  const components: ScoreComponent[] = [{ feature: "category", points: 70, label: "One of your price or volume rules fired" }];
  if (s.hits.some((h) => h.id === "price") && s.changePct != null) {
    const times = Math.abs(s.changePct) / t.pricePct;
    components.push({ feature: "magnitude", points: Math.round(Math.min(14, (times - 1) * 10)), label: `Moved ${formatPct(s.changePct)}, ${times.toFixed(1)}× your ±${t.pricePct}% rule` });
  }
  if (s.hits.some((h) => h.id === "volume") && s.volumeRatio != null) {
    const times = s.volumeRatio / t.volumeMultiple;
    components.push({ feature: "magnitude", points: Math.round(Math.min(10, Math.max(0, (times - 1) * 6))), label: `Volume ${s.volumeRatio.toFixed(1)}× its ${t.lookback}-day average (${times.toFixed(1)}× your ${t.volumeMultiple}× rule)` });
  }
  if (s.hits.some((h) => h.id === "high52" || h.id === "low52")) {
    components.push({ feature: "magnitude", points: 4, label: s.hits.some((h) => h.id === "high52") ? "Closed at a 52-week high" : "Closed at a 52-week low" });
  }
  const recency = opts.ageHours <= 30 ? null : { feature: "recency" as const, points: opts.ageHours > 24 * 7 ? -6 : -3, label: `Session ${Math.round(opts.ageHours / 24)} days ago` };
  if (recency) components.push(recency);
  if (opts.corroboration) components.push({ feature: "relevance", points: 5, label: opts.corroboration });
  const conf = confidenceComponent(opts.confidence);
  if (conf) components.push(conf);
  const score = total(components);
  return { score, tier: "attention", triggered: true, components, confidence: opts.confidence };
}

// ---- Magnitude, per kind of event -------------------------------------------------------------

function pctOf(c: Change): number | null {
  return c.kind === "pct" ? c.value : null;
}

/** Results: the larger of the revenue and PAT swing against the same quarter last year. */
export function resultsMagnitude(snapshot: ResultsSnapshot | null | undefined): Magnitude | null {
  if (!snapshot || snapshot.status !== "ok") return null;
  const rev = snapshot.metrics.find((m) => m.key === "revenue");
  const pat = snapshot.metrics.find((m) => m.key === "pat");
  if (pat?.yoy.kind === "turned_negative") return { points: 10, label: "Swung to a loss against the same quarter last year" };
  if (pat?.yoy.kind === "turned_positive") return { points: 8, label: "Back to profit against the same quarter last year" };
  const r = rev ? pctOf(rev.yoy) : null;
  const p = pat ? pctOf(pat.yoy) : null;
  const moves = [r == null ? null : { what: "Revenue", v: r }, p == null ? null : { what: "PAT", v: p }].filter((x): x is { what: string; v: number } => x != null);
  if (!moves.length) return null;
  const big = moves.reduce((a, b) => (Math.abs(b.v) > Math.abs(a.v) ? b : a));
  const a = Math.abs(big.v);
  if (a >= 25) return { points: 10, label: `Large change: ${big.what} ${formatPct(big.v)} YoY` };
  if (a >= 10) return { points: 5, label: `${big.what} ${formatPct(big.v)} YoY` };
  if (moves.every((m) => Math.abs(m.v) < 5)) return { points: -3, label: `Little changed from last year (${moves.map((m) => `${m.what} ${formatPct(m.v)}`).join(", ")})` };
  return null;
}

/** An order or deal sized against the company's last four quarters of revenue. */
export function sizeVsRevenue(what: "Order" | "Deal", amountInr: number | null | undefined, ttmRevenueCr: number | null | undefined): Magnitude {
  if (!amountInr) return { points: 0, label: `${what} value not stated in the filing` };
  const cr = amountInr / 1e7;
  if (!ttmRevenueCr || ttmRevenueCr <= 0) return { points: 0, label: `${what} worth ${formatCroreInr(cr)}; revenue not available to compare` };
  const share = (cr / ttmRevenueCr) * 100;
  const label = `${what} worth ${formatCroreInr(cr)}, ${share >= 1 ? share.toFixed(0) : share.toFixed(1)}% of the last 12 months' revenue`;
  if (share >= 10) return { points: 10, label };
  if (share >= 2) return { points: 5, label };
  return { points: -5, label: `${label} — small for the company` };
}

/** Fresh equity: how much the share count grows. */
export function dilutionMagnitude(dilutionPct: number | null | undefined): Magnitude | null {
  if (dilutionPct == null) return null;
  const label = `Adds ${dilutionPct < 0.01 ? dilutionPct.toFixed(4) : dilutionPct.toFixed(2)}% to the share count`;
  if (dilutionPct >= 5) return { points: 10, label };
  if (dilutionPct >= 1) return { points: 5, label };
  return { points: -3, label };
}
