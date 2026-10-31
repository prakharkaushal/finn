import { METRIC_LABEL, rangeLabel } from "@/lib/research/guidance";
import { CHECK_LABEL } from "@/lib/research/narrative";
import type { CasePoint, CaseSection, Citation, Claim, ClaimCheck, GuidanceStatement } from "@/lib/research/types";

/**
 * Bull vs bear, assembled by rules from facts the report already cites: favourable and
 * unfavourable financial claims, promises met or missed, and management numbers that did or
 * did not match the reported ones. Each point carries its citations and the strongest fact on
 * the other side of the same theme. No model, no new facts, and no recommendation.
 */

type Item = { theme: CasePoint["theme"]; text: string; citations: Citation[]; weight: number };

const THEMES: CasePoint["theme"][] = ["growth", "profitability", "cash", "balance sheet", "working capital", "credibility"];

export function themeOf(claimId: string): CasePoint["theme"] {
  if (claimId.startsWith("bs-")) return "balance sheet";
  if (claimId.startsWith("cash-")) return "cash";
  if (claimId.startsWith("wc-")) return "working capital";
  if (claimId === "traj-margin") return "profitability";
  return "growth";
}

const quoteCite = (s: { sourceId: string; page: number; speaker?: string; quote: string }): Citation => ({
  sourceId: s.sourceId,
  page: s.page,
  ...(s.speaker ? { speaker: s.speaker } : {}),
  excerpt: s.quote.length > 220 ? `${s.quote.slice(0, 217)}…` : s.quote,
  level: "page",
});

function promises(statements: GuidanceStatement[], outcome: "met" | "short"): Item | null {
  const pick = statements.filter(
    (s) => s.voice !== "analyst" && (outcome === "met" ? s.assessment === "met" : s.assessment === "missed" || s.assessment === "partially met"),
  );
  if (!pick.length) return null;
  const checkable = statements.filter((s) => s.voice !== "analyst" && s.assessment && s.assessment !== "not comparable / insufficient evidence").length;
  const first = pick[0];
  const what = `${METRIC_LABEL[first.metric!]} ${rangeLabel(first)} for ${first.period?.label ?? "the period"}`;
  return {
    theme: "credibility",
    text:
      outcome === "met"
        ? `Management met ${pick.length} of ${checkable} checkable promises, e.g. ${what} (${first.assessmentNote}).`
        : `Management fell short on ${pick.length} of ${checkable} checkable promises, e.g. ${what} (${first.assessmentNote}).`,
    citations: pick.slice(0, 3).map(quoteCite),
    weight: pick.length,
  };
}

function checks(list: ClaimCheck[], status: "consistent" | "conflict"): Item | null {
  const pick = list.filter((c) => c.status === status);
  if (!pick.length) return null;
  const c = pick[0];
  return {
    theme: "credibility",
    text:
      status === "conflict"
        ? `A number management stated does not match the reported one: ${CHECK_LABEL[c.metric]} for ${c.quarter} — ${c.note}`
        : `Numbers management stated on calls match the reported figures (${pick.length} checked, e.g. ${CHECK_LABEL[c.metric]} for ${c.quarter}).`,
    citations: pick.slice(0, 3).map(quoteCite),
    weight: pick.length,
  };
}

function pickSide(items: Item[], max = 4): Item[] {
  const chosen: Item[] = [];
  for (const theme of THEMES) {
    const best = items.filter((i) => i.theme === theme).sort((a, b) => b.weight - a.weight)[0];
    if (best) chosen.push(best);
  }
  return chosen.slice(0, max);
}

export function buildCase(input: { claims: Claim[]; statements: GuidanceStatement[]; checks: ClaimCheck[] }): CaseSection {
  const bull: Item[] = [];
  const bear: Item[] = [];
  for (const c of input.claims) {
    if (c.tone === "neutral") continue;
    (c.tone === "positive" ? bull : bear).push({ theme: themeOf(c.id), text: c.text, citations: c.citations, weight: c.citations.some((x) => x.level === "page") ? 2 : 1 });
  }
  const met = promises(input.statements, "met");
  const short = promises(input.statements, "short");
  const consistent = checks(input.checks, "consistent");
  const conflict = checks(input.checks, "conflict");
  if (met) bull.push(met);
  if (consistent) bull.push(consistent);
  if (short) bear.push(short);
  if (conflict) bear.push({ ...conflict, weight: conflict.weight + 2 });

  const withCounter = (side: Item[], other: Item[]): CasePoint[] =>
    pickSide(side).map((i) => {
      const against = other.filter((o) => o.theme === i.theme).sort((a, b) => b.weight - a.weight)[0];
      return { theme: i.theme, text: i.text, citations: i.citations, counter: against ? { text: against.text, citations: against.citations } : null };
    });

  return {
    bull: withCounter(bull, bear),
    bear: withCounter(bear, bull),
    note: "Assembled by rules from the cited facts in this report; each point shows the strongest fact against it. It weighs evidence, it is not a recommendation to buy or sell.",
  };
}
