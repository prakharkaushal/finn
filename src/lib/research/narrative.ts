import type { StatementSet } from "@/lib/data/schema";
import { formatCroreInr, formatPct } from "@/lib/domain/numbers";
import { quarterDiscussedOnCall } from "@/lib/domain/periods";
import { resultsSnapshot } from "@/lib/domain/results";
import { isSegmentScoped, METRIC_LABEL, rangeLabel } from "@/lib/research/guidance";
import type { Sentence } from "@/lib/research/transcript";
import type { Assessment, ClaimCheck, GuidanceStatement } from "@/lib/research/types";

/**
 * Narrative vs numbers. Two checks, both deterministic:
 *  1. Promises: each scored guidance statement gets the brief's assessment — met, partially met,
 *     missed, or not comparable / insufficient evidence — with the reason spelled out.
 *  2. Claims: numbers management stated about the quarter just finished ("revenue grew 18%
 *     year-on-year") are checked against the reported quarter. A gap beyond the tolerance is
 *     flagged as a conflict and left for the reader; FINN does not decide who is right.
 */

const INSUFFICIENT: Assessment = "not comparable / insufficient evidence";

/** "Partially met": within 10% of a ₹ target, or 2 percentage points of a growth target (1 for a margin). */
export function assess(s: Pick<GuidanceStatement, "metric" | "low" | "high" | "unit" | "verdict" | "period">): { assessment: Assessment; note: string } {
  const v = s.verdict;
  if (!v || !s.metric) return { assessment: INSUFFICIENT, note: "Not a quantified promise" };
  const promised = rangeLabel(s);
  const shown = (x: number) => (s.unit === "INR_cr" ? formatCroreInr(x) : `${x.toFixed(1)}%`);
  const actual = v.actual != null ? shown(v.actual) : null;
  switch (v.status) {
    case "delivered":
      return { assessment: "met", note: `${actual} reported against ${promised} promised` };
    case "beat":
      return { assessment: "met", note: `${actual} reported, above the ${promised} promised` };
    case "missed": {
      if (v.actual == null) return { assessment: "missed", note: `Below the ${promised} promised` };
      if (s.unit === "INR_cr") {
        const target = s.low ?? s.high!;
        const share = (v.actual / target) * 100;
        return share >= 90
          ? { assessment: "partially met", note: `${actual} reported — ${share.toFixed(0)}% of the ${promised} promised` }
          : { assessment: "missed", note: `${actual} reported — ${share.toFixed(0)}% of the ${promised} promised` };
      }
      const gap = (s.low ?? s.high!) - v.actual;
      const near = s.metric.endsWith("margin") ? 1 : 2;
      return gap <= near
        ? { assessment: "partially met", note: `${actual} reported — ${gap.toFixed(1)} percentage points short of ${promised}` }
        : { assessment: "missed", note: `${actual} reported — ${gap.toFixed(1)} percentage points short of ${promised}` };
    }
    case "on_track":
    case "behind":
      return { assessment: INSUFFICIENT, note: `${s.period?.label ?? "The period"} is not over yet; so far ${v.status === "on_track" ? "on track" : "behind"} (${v.actualLabel ?? actual})` };
    case "pending":
      return { assessment: INSUFFICIENT, note: v.basis };
    default:
      return { assessment: INSUFFICIENT, note: v.basis };
  }
}

export const ASSESSMENT_RULE =
  "Met: reported inside or above the promise. Partially met: within 10% of a ₹ target, or within 2 percentage points of a growth target (1 for a margin). Missed: further short. Not comparable / insufficient evidence: the period is not over, the promise is about one segment, or no reported figure measures it.";

// ---- Claimed vs reported -------------------------------------------------------------------

const YOY = /\b(?:y-?o-?y|year[- ]on[- ]year|year[- ]over[- ]year|over the (?:same|corresponding) (?:quarter|period) (?:of )?(?:the )?(?:last|previous) year)\b/i;
const QUARTER = /\b(?:this|the|current|reported) quarter\b|\bq[1-4]\b|\bquarter under review\b/i;
const NOT_QUARTER = /\b(?:full[- ]year|for the (?:full )?year|nine months|9m|first half|second half|h1|h2|half[- ]year|ytd|year[- ]to[- ]date|annual)\b/i;
const FORWARD = /\b(?:will|expect\w*|guid\w*|target\w*|aim\w*|should|going forward|outlook|next year|next quarter|plan\w*|project\w*)\b/i;
const NOT_MANAGEMENT = /moderator|analyst|participant|operator/i;

const PATTERNS: { metric: ClaimCheck["metric"]; re: RegExp; needsYoY: boolean }[] = [
  { metric: "revenue_growth", re: /\b(?:revenues?|top[- ]?line|sales|income from operations)\b[^.?!]{0,60}?\b(?:grew|growth(?: of)?|increased|rose|was up|is up|up)\b[^.?!%]{0,25}?(\d{1,3}(?:\.\d+)?)\s?%/i, needsYoY: true },
  { metric: "pat_growth", re: /\b(?:pat|net profit|profit after tax)\b[^.?!]{0,60}?\b(?:grew|growth(?: of)?|increased|rose|was up|is up|up)\b[^.?!%]{0,25}?(\d{1,3}(?:\.\d+)?)\s?%/i, needsYoY: true },
  { metric: "ebitda_margin", re: /\bebitda margins?\b[^.?!]{0,40}?\b(?:of|at|was|were|stood at|came in at|is|improved to|expanded to|declined to|contracted to)\s*(\d{1,2}(?:\.\d+)?)\s?%/i, needsYoY: false },
];

/** Tolerance before a gap is a conflict: company definitions and rounding differ from the standardised table. */
export const TOLERANCE: Record<ClaimCheck["metric"], number> = { revenue_growth: 2, pat_growth: 2, ebitda_margin: 1 };

export type CallSentences = { sourceId: string; callMonth: string; sentences: Sentence[] };

export function checkClaimedActuals(calls: CallSentences[], company: StatementSet): ClaimCheck[] {
  const out: ClaimCheck[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const quarter = quarterDiscussedOnCall(call.callMonth);
    if (!quarter) continue;
    const snap = resultsSnapshot(company, quarter.end);
    const reportedFor = (metric: ClaimCheck["metric"]): number | null => {
      if (snap.status !== "ok") return null;
      if (metric === "ebitda_margin") return company.isLender ? null : (snap.margins.find((m) => m.label === "EBITDA margin")?.current ?? null);
      const m = snap.metrics.find((x) => x.key === (metric === "revenue_growth" ? "revenue" : "pat"));
      return m?.status === "ok" && m.yoy.kind === "pct" ? m.yoy.value : null;
    };
    for (const s of call.sentences) {
      if (s.isQuestion || NOT_MANAGEMENT.test(s.speaker ?? "") || /^(sir|madam|ma'?am)\b/i.test(s.text)) continue;
      if (FORWARD.test(s.text) || NOT_QUARTER.test(s.text) || !QUARTER.test(s.text) || isSegmentScoped(s.text)) continue;
      for (const p of PATTERNS) {
        const m = s.text.match(p.re);
        if (!m || (p.needsYoY && !YOY.test(s.text))) continue;
        const claimed = Number(m[1]);
        const key = `${quarter.label}|${p.metric}|${claimed}`;
        if (!Number.isFinite(claimed) || seen.has(key)) continue;
        seen.add(key);
        const reported = reportedFor(p.metric);
        const shown = (x: number) => (p.metric === "ebitda_margin" ? `${x.toFixed(1)}%` : formatPct(x));
        let status: ClaimCheck["status"] = "not comparable";
        let note = `No reported ${quarter.label} figure to check against${company.isLender && p.metric === "ebitda_margin" ? " (EBITDA is not meaningful for a lender)" : ""}`;
        if (reported != null) {
          const gap = Math.abs(claimed - reported);
          status = gap > TOLERANCE[p.metric] ? "conflict" : "consistent";
          note =
            status === "conflict"
              ? `Said ${shown(claimed)}; the reported ${company.basis} figure is ${shown(reported)} — a ${gap.toFixed(1)}-point gap. Definitions or basis may differ; check the filing.`
              : `Said ${shown(claimed)}; reported ${shown(reported)} (${company.basis}).`;
        }
        out.push({
          id: `${call.sourceId}-check-${out.length + 1}`,
          sourceId: call.sourceId,
          page: s.page,
          ...(s.speaker ? { speaker: s.speaker } : {}),
          quote: s.text,
          metric: p.metric,
          quarter: quarter.label,
          claimed,
          reported,
          status,
          note,
        });
      }
    }
  }
  return out.slice(0, 12);
}

export const CHECK_LABEL: Record<ClaimCheck["metric"], string> = {
  revenue_growth: "Revenue growth (YoY)",
  pat_growth: "PAT growth (YoY)",
  ebitda_margin: "EBITDA margin",
};

export { METRIC_LABEL };
