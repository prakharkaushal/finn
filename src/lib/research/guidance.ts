import { fyLabel, quarterDiscussedOnCall } from "@/lib/domain/periods";
import { pctChange } from "@/lib/domain/numbers";
import type { StatementSet, StatementTable } from "@/lib/data/schema";
import type { Sentence } from "@/lib/research/transcript";
import type { GuidanceMetric, GuidancePeriod, GuidanceStatement, Revision, Verdict } from "@/lib/research/types";

/**
 * "Promised vs delivered", deterministic first:
 *  1. find management's forward-looking statements verbatim in the transcript;
 *  2. parse the common forms ("15–17% revenue growth", "EBITDA margin of 18-19%", "mid-teens");
 *  3. score each against what the company later reported.
 * An LLM (optional) only structures the sentences these rules could not.
 */

// ---------- 1. Candidate sentences -------------------------------------------------------

const CUE =
  /\b(guid(?:e|ed|ance|ing)|expect(?:s|ed|ing)?|anticipat\w*|target(?:s|ed|ing)?|aim(?:s|ing)?|outlook|aspir\w*|corridor|should (?:be|see|grow|deliver|come|remain)|will (?:be|grow|deliver|see|reach|achieve|remain|continue)|would like to|we see|going forward|next (?:year|fiscal|few quarters)|coming (?:year|quarters)|medium[- ]term|confident|on track|maintain(?:ing)?|reiterat\w*|commit\w*)\b/i;
/** Reported-results phrasing; without a forward cue these are history, not promises. */
const PAST = /\b(was|were|grew|rose|declined|increased|decreased|stood at|came in at|reported|registered|clocked)\b/i;
const FORWARD = /\b(will|expect|guid|target|aim|should|going forward|outlook|corridor|next year|next fiscal|would like to)\w*/i;
const METRIC_WORD = /\b(revenue|top[- ]?line|sales|growth|margins?|ebitda|operating profit|pat|net profit|profitability|volumes?|capex|capital expenditure|order (?:book|inflow))\b/i;
const NUMBER_WORD =
  /(\d+(?:\.\d+)?\s?(?:%|percent|per cent|bps|basis points)|double[- ]digits?|single[- ]digits?|(?:low|mid|high)[- ](?:teens|single[- ]digits?|double[- ]digits?)|\bteens\b|(?:rs\.?|₹|inr)\s?[\d,]+(?:\.\d+)?\s?(?:crores?|cr|billion|bn))/i;
const PERIOD_WORD = /\b(FY\s?'?\d{2,4}|fiscal\s?(?:year\s?)?'?\d{2,4}|20\d{2}\s?-\s?\d{2}|H[12]|Q[1-4]\s?FY|this (?:year|fiscal)|next (?:year|fiscal)|current (?:year|fiscal)|full[- ]year|second half|first half)\b/i;

export function candidateScore(s: Sentence): number {
  if (s.isQuestion || /moderator/i.test(s.speaker ?? "") || s.text.length > 600) return 0;
  let score = 0;
  if (CUE.test(s.text)) score += 2;
  if (/\bguid(?:e|ed|ance|ing)\b/i.test(s.text)) score += 2;
  if (METRIC_WORD.test(s.text)) score += 2;
  if (NUMBER_WORD.test(s.text)) score += 2;
  if (PERIOD_WORD.test(s.text)) score += 1;
  if (PAST.test(s.text) && !FORWARD.test(s.text)) score -= 3;
  return score;
}

export function findCandidates(sentences: Sentence[], limit = 12): Sentence[] {
  return sentences
    .map((s, i) => ({ s, i, score: candidateScore(s) }))
    .filter((c) => c.score >= 6)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map((c) => c.s);
}

// ---------- 2. Rule-based structuring ------------------------------------------------------

type Parsed = {
  metric: GuidanceMetric;
  low?: number;
  high?: number;
  unit: "%" | "INR_cr";
  interpreted: boolean;
  /** Where the number sits in the sentence; the period nearest to it is the one it refers to. */
  at: number;
  /** True when the clause around the number is about part of the business (a brand, subsidiary, segment). */
  segment: boolean;
};

/** Order matters: the specific phrases must be tried before "double digit". */
const QUALITATIVE: [RegExp, number, number | undefined][] = [
  [/low[- ]double[- ]digits?/gi, 10, 12],
  [/high[- ]single[- ]digits?/gi, 7, 9],
  [/mid[- ]single[- ]digits?/gi, 4, 6],
  [/low[- ]single[- ]digits?/gi, 1, 3],
  [/high[- ]teens/gi, 17, 19],
  [/mid[- ]teens/gi, 14, 16],
  [/low[- ]teens/gi, 11, 13],
  [/double[- ]digits?/gi, 10, undefined],
  [/\bteens\b/gi, 11, 19],
];

const METRIC_PATTERNS: { metric: GuidanceMetric | "unqualified_margin"; kind: "pct" | "amount"; re: RegExp }[] = [
  { metric: "ebit_margin", kind: "pct", re: /\bebit\s*(?:level\s*)?(?:margins?|corridor|band|guidance)\b/gi },
  { metric: "ebitda_margin", kind: "pct", re: /\b(?:ebitda|operating)\s*(?:level\s*)?(?:margins?|corridor|band)\b/gi },
  // "margin guidance" with no qualifier: resolved from the rest of the sentence below.
  { metric: "unqualified_margin", kind: "pct", re: /\bmargins?\s*(?:corridor|band|guidance)\b/gi },
  { metric: "revenue_growth", kind: "pct", re: /\b(?:revenue|top[- ]?line|sales)\s*(?:growth|to grow|will grow|should grow|grow)\b|\bgrowth in (?:the )?(?:revenue|sales|top[- ]?line)\b|\bgrow (?:the |our )?(?:revenue|top[- ]?line|sales)\b/gi },
  { metric: "ebitda_growth", kind: "pct", re: /\bebitda\s*(?:growth|to grow|will grow|should grow)\b|\bgrowth in (?:the )?ebitda\b/gi },
  { metric: "pat_growth", kind: "pct", re: /\b(?:pat|net profit|profit after tax|bottom[- ]?line)\s*(?:growth|to grow|will grow|should grow)\b|\bgrowth in (?:the )?(?:bottom[- ]?line|pat|net profit|profits?)\b/gi },
  { metric: "volume_growth", kind: "pct", re: /\bvolumes?\s*(?:growth|to grow|will grow|should grow)\b|\bgrowth in (?:the )?volumes?\b/gi },
  { metric: "capex", kind: "amount", re: /\b(?:capex|capital expenditure)\b/gi },
  { metric: "revenue_target", kind: "amount", re: /\b(?:revenues?|top[- ]?line|turnover|sales)\b/gi },
];

// A number must stand alone: "2027 to 16%" is not a 27–16% range, "Q4 to 17%" is not 4–17%.
const NUM = "(?<![\\w.,])(\\d{1,3}(?:\\.\\d+)?)";
const FROM_TO_RE = new RegExp(`from\\s+(?:the\\s+)?${NUM}\\s?%\\s+to\\s+${NUM}\\s?%`, "gi");
const RANGE_RE = new RegExp(`${NUM}\\s?%?\\s?(?:-|–|—|to)\\s?${NUM}\\s?(?:%|percent|per cent)`, "gi");
const SINGLE_RE = new RegExp(`(at least|over|more than|upwards of|north of|above|around|about|approximately|close to|~)?\\s?${NUM}\\s?(?:%|percent|per cent)(\\s?\\+|\\s?plus)?`, "gi");
const AMOUNT_RANGE_RE = /(?:rs\.?|₹|inr)\s?([\d,]+(?:\.\d+)?)\s?(?:crores?|cr)?\s?(?:-|–|to)\s?(?:rs\.?|₹|inr)?\s?([\d,]+(?:\.\d+)?)\s?(crores?|cr|billion|bn)\b/gi;
const AMOUNT_RE = /(?:rs\.?|₹|inr)\s?([\d,]+(?:\.\d+)?)\s?(crores?|cr|billion|bn)\b/gi;

/** A number reported as history ("we delivered 33%", "ended up at ₹2,700 crores") is not a promise. */
const PAST_IN_CLAUSE = /\b(delivered|achieved|grew|reported|posted|recorded|clocked|registered|came in at|stood at|have seen|saw|we did|ended up|end up|ended at|ended the year)\b/i;
const PAST_AFTER = /^[^.]{0,30}?\b(what we did|we did|we delivered|we achieved|we reported|we ended|we closed)\b/i;
const FORWARD_CUE = /\b(guid\w*|target\w*|expect\w*|aim\w*|aspir\w*|commit\w*|will|should|plan\w*|outlook|envisag\w*|project\w*|going to|confident)\b/i;

/**
 * Targets for one business, plant or order book can't be checked against company totals,
 * so those statements are kept as quotes but never scored.
 */
const SEGMENT = /\b(business(?:es)?|segments?|divisions?|verticals?|subsidiar(?:y|ies)|plants?|facilit(?:y|ies)|brands?|product lines?|orders?|order book|order inflow|contracts?|exports?|geograph\w*|regions?)\b/i;
const COMPANY_WIDE = /\b(consolidated|overall|total|company[- ]wide|for the company|at the company level)\b/i;
export function isSegmentScoped(text: string): boolean {
  return SEGMENT.test(text) && !COMPANY_WIDE.test(text);
}

/** Capitalised words that are not names of a business unit. */
const NOT_A_UNIT = new Set(
  "I We The So And But Also Now This That These Those In On For As Our It If Okay Yes Sir Madam Going Next Last Overall Consolidated Revenue Revenues Sales Margin Margins Growth Volume Volumes Guidance EBIT EBITDA PAT PBT FY CY INR Rs GST US USD CEO CFO COO MD India Indian Q H January February March April May June July August September October November December"
    .split(" "),
);

/** The clause containing position `at`, bounded by , ; : — or sentence edges. */
function clauseAround(text: string, at: number): { clause: string; startsSentence: boolean } {
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf(":"), before.lastIndexOf("—"), before.lastIndexOf(" -- ")) + 1;
  const rel = text.slice(at).search(/[,;](\s|$)|\.(\s|$)/);
  const end = rel < 0 ? text.length : at + rel;
  return { clause: text.slice(start, end), startsSentence: start === 0 };
}

/**
 * Scope of one number: a proper noun in its own clause ("CaratLane … double-digit EBIT
 * margin") means a brand or subsidiary, unless the clause itself says consolidated/overall.
 */
export function clauseIsSegment(text: string, at: number, companyName = ""): boolean {
  const { clause, startsSentence } = clauseAround(text, at);
  if (COMPANY_WIDE.test(clause)) return false;
  if (SEGMENT.test(clause)) return true;
  const own = new Set(companyName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const words = [...clause.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)];
  return words.some((m, i) => {
    if (i === 0 && startsSentence && m.index === clause.search(/\S/)) return false;
    const w = m[0];
    return !NOT_A_UNIT.has(w) && !own.has(w.toLowerCase()) && !/^(FY|Q|H)\d/.test(w);
  });
}

type Hit = { index: number; end: number; kind: "pct" | "amount"; low?: number; high?: number; interpreted: boolean };

function clauseBefore(text: string, index: number): string {
  const head = text.slice(0, index);
  const cut = Math.max(head.lastIndexOf(","), head.lastIndexOf(";"), head.lastIndexOf(":"), head.lastIndexOf(" but "));
  return head.slice(cut + 1);
}

function numberHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const overlaps = (i: number, e: number) => hits.some((h) => i < h.end && e > h.index);
  // "from 15.5% to 16%" is a revision: the target is the new number.
  for (const m of text.matchAll(FROM_TO_RE)) {
    const to = Number(m[2]);
    hits.push({ index: m.index!, end: m.index! + m[0].length, kind: "pct", low: to, high: to, interpreted: false });
  }
  for (const m of text.matchAll(RANGE_RE)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    hits.push({ index: m.index!, end: m.index! + m[0].length, kind: "pct", low: Math.min(a, b), high: Math.max(a, b), interpreted: false });
  }
  for (const m of text.matchAll(SINGLE_RE)) {
    const start = m.index! + (m[0].length - m[0].trimStart().length);
    if (overlaps(start, m.index! + m[0].length)) continue;
    const v = Number(m[2]);
    const open = /at least|over|more than|upwards|north|above/i.test(m[1] ?? "") || Boolean(m[3]);
    hits.push({ index: start, end: m.index! + m[0].length, kind: "pct", low: v, high: open ? undefined : v, interpreted: false });
  }
  for (const [re, low, high] of QUALITATIVE) {
    for (const m of text.matchAll(re)) {
      if (overlaps(m.index!, m.index! + m[0].length)) continue;
      hits.push({ index: m.index!, end: m.index! + m[0].length, kind: "pct", low, high, interpreted: true });
    }
  }
  const toCrore = (n: string, unit: string) => Number(n.replace(/,/g, "")) * (/billion|bn/i.test(unit) ? 100 : 1);
  for (const m of text.matchAll(AMOUNT_RANGE_RE)) {
    const a = toCrore(m[1], m[3]);
    const b = toCrore(m[2], m[3]);
    hits.push({ index: m.index!, end: m.index! + m[0].length, kind: "amount", low: Math.min(a, b), high: Math.max(a, b), interpreted: false });
  }
  for (const m of text.matchAll(AMOUNT_RE)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    const crore = toCrore(m[1], m[2]);
    hits.push({ index: m.index!, end: m.index! + m[0].length, kind: "amount", low: crore, high: crore, interpreted: false });
  }
  return hits.filter((h) => {
    const clause = clauseBefore(text, h.index);
    const after = text.slice(h.end);
    if (PAST_IN_CLAUSE.test(clause) || PAST_AFTER.test(after)) return false;
    // "margin was 15.2%" is history; "our guidance was 15%" is still the promise.
    if (/\b(?:was|were)\s*(?:about|around|at|~)?\s*$/i.test(text.slice(Math.max(0, h.index - 16), h.index)) && !/guid|target|outlook/i.test(clause)) return false;
    // "<metric> at 20.5%" states the current level unless the clause looks forward.
    if (/\bat\s*(?:about|around|~)?\s*$/i.test(text.slice(Math.max(0, h.index - 12), h.index)) && !FORWARD_CUE.test(clause)) return false;
    // FINN checks consolidated figures; a standalone-basis target is a different promise.
    if (/^\s*(?:on\s+an?\s+)?standalone\b/i.test(after)) return false;
    return true;
  });
}

/**
 * One structured item per metric mentioned. Each metric phrase takes the nearest number of
 * the right kind (percent for growth/margins, rupees for capex and revenue targets).
 */
export function parseGuidance(text: string, companyName = ""): Parsed[] {
  const hits = numberHits(text);
  // Every (metric phrase, number) pairing within reach, closest first; each number and each
  // metric is used once. Greedy nearest-first keeps "EBITDA margins of 20.5%" from being
  // claimed by an "EBIT margins" phrase further away in the same sentence.
  const pairs: { metric: (typeof METRIC_PATTERNS)[number]["metric"]; kind: Hit["kind"]; hit: Hit; dist: number }[] = [];
  for (const { metric, kind, re } of METRIC_PATTERNS) {
    if (metric === "revenue_target" && !FORWARD_CUE.test(text)) continue;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      const end = at + m[0].length;
      for (const h of hits) {
        if (h.kind !== kind) continue;
        const dist = h.end <= at ? at - h.end : h.index >= end ? h.index - end : 0;
        if (dist <= (h.end <= at ? 45 : 90)) pairs.push({ metric, kind, hit: h, dist });
      }
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);
  const usedHits = new Set<Hit>();
  const out: Parsed[] = [];
  for (const p of pairs) {
    const metric: GuidanceMetric =
      p.metric !== "unqualified_margin" ? p.metric : /\bebitda\b/i.test(text) ? "ebitda_margin" : /\bebit\b/i.test(text) ? "ebit_margin" : "other";
    if (usedHits.has(p.hit) || out.some((o) => o.metric === metric)) continue;
    usedHits.add(p.hit);
    out.push({
      metric,
      unit: p.kind === "amount" ? "INR_cr" : "%",
      low: p.hit.low,
      high: p.hit.high,
      interpreted: p.hit.interpreted,
      at: p.hit.index,
      segment: clauseIsSegment(text, p.hit.index, companyName),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- 3. Fiscal period of a statement --------------------------------------------------

function toFy(raw: string): number {
  const n = Number(raw);
  return n < 100 ? 2000 + n : n;
}

/** The fiscal year a call treats as "this year": after a Q4 call, the new year has begun. */
export function currentFyForCall(callMonth: string): number | null {
  const q = quarterDiscussedOnCall(callMonth);
  if (!q) return null;
  return q.q === 4 ? q.fy + 1 : q.fy;
}

/** "At the start of the year we had guided…" looks back at the year under discussion. */
const RETROSPECTIVE =
  /\b(?:had|we|have) (?:guided|given|said|indicated|shared|promised|committed)\b|\b(?:at the start|beginning) of the year\b|\b(?:was|were)\b(?:[^.]|\.\d){0,40}\bagainst (?:our|the) guidance\b/i;

type Q = 1 | 2 | 3 | 4;

/**
 * The fiscal period a number refers to. With `anchor` (the number's position), the period
 * mention nearest to it wins — "Q3 … improvement in EBIT margin in Q4 to 17%" is about Q4.
 */
export function parsePeriod(text: string, callMonth: string, anchor?: number): GuidancePeriod | null {
  const discussed = quarterDiscussedOnCall(callMonth);
  // After a Q4 call "this year" is the new year — unless the speaker is looking back.
  const current = discussed && discussed.q === 4 && RETROSPECTIVE.test(text) ? discussed.fy : currentFyForCall(callMonth);
  const make = (scope: GuidancePeriod["scope"], fy: number, inferred: boolean, quarter?: Q): GuidancePeriod => ({
    scope,
    fy,
    inferred,
    quarter,
    label: scope === "FY" ? fyLabel(fy) : scope === "Q" ? `Q${quarter} ${fyLabel(fy)}` : `${scope} ${fyLabel(fy)}`,
  });

  const found: { at: number; len: number; period: GuidancePeriod }[] = [];
  const add = (re: RegExp, build: (m: RegExpMatchArray) => GuidancePeriod | null) => {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (found.some((f) => at >= f.at && at < f.at + f.len)) continue;
      const period = build(m);
      if (period) found.push({ at, len: m[0].length, period });
    }
  };
  add(/\bQ([1-4])\s?(?:of\s)?(?:FY\s?'?|fiscal\s?(?:year\s?)?)(\d{2,4})\b/gi, (m) => make("Q", toFy(m[2]), false, Number(m[1]) as Q));
  add(/\b([1-4])Q\s?FY\s?'?(\d{2,4})\b/gi, (m) => make("Q", toFy(m[2]), false, Number(m[1]) as Q));
  add(/\b(H[12])\s?(?:of\s)?FY\s?'?(\d{2,4})\b/gi, (m) => make(/h1/i.test(m[1]) ? "H1" : "H2", toFy(m[2]), false));
  add(/\bFY\s?20(\d{2})\s?-\s?(\d{2})\b/gi, (m) => make("FY", toFy(m[2]), false));
  add(/\b(?:FY|fiscal(?:\s?year)?)\s?'?(\d{2,4})\b/gi, (m) => make("FY", toFy(m[1]), false));
  if (discussed) {
    add(/\b(?:current|this) quarter\b/gi, () => make("Q", discussed.fy, true, discussed.q));
  }
  if (current) {
    add(/\bQ([1-4])\b|\b([1-4])Q\b/g, (m) => make("Q", current, true, Number(m[1] ?? m[2]) as Q));
    add(/\b(H[12])\b|\b(first|second) half\b/gi, (m) => make(/h1|first/i.test(m[0]) ? "H1" : "H2", current, true));
    add(/\bnext (?:year|fiscal|financial year)\b/gi, () => make("FY", current + 1, true));
    add(/\b(?:last|previous) (?:year|fiscal|financial year)\b/gi, () => make("FY", current - 1, true));
  }
  if (found.length) {
    const explicit = found.filter((f) => !f.period.inferred);
    const pool = explicit.length ? explicit : found;
    if (anchor == null) return pool.sort((a, b) => a.at - b.at)[0].period;
    return pool.sort((a, b) => Math.abs(a.at - anchor) - Math.abs(b.at - anchor))[0].period;
  }
  return current ? make("FY", current, true) : null;
}

// ---------- 4. Evaluation against reported numbers -----------------------------------------

type Series = (key: string) => number | null;

function seriesFrom(table: StatementTable, rows: string[]): Series {
  const row = rows.find((r) => r in table.rows);
  return (key) => {
    if (!row) return null;
    const idx = table.periods.findIndex((p) => p.key === key);
    return idx < 0 ? null : (table.rows[row][idx] ?? null);
  };
}

function quarterKeys(fy: number, scope: GuidancePeriod["scope"], quarter?: number): string[] {
  const all = [`${fy - 1}-06-30`, `${fy - 1}-09-30`, `${fy - 1}-12-31`, `${fy}-03-31`];
  if (scope === "H1") return all.slice(0, 2);
  if (scope === "H2") return all.slice(2);
  if (scope === "Q" && quarter) return [all[quarter - 1]];
  return all;
}

const lastYear = (key: string) => `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`;

type Actual = { value: number; complete: boolean; label: string; basis: string; quartersReported?: number; quartersInPeriod?: number };

/** Reported revenue in ₹ crore for a period: the annual figure when complete, else the quarters so far. */
function revenueFor(period: GuidancePeriod, c: StatementSet): Actual | null {
  const rev = ["sales", "revenue"];
  if (period.scope === "FY") {
    const annual = seriesFrom(c.annual, rev)(`${period.fy}-03-31`);
    if (annual != null) return { value: annual, complete: true, label: `${fyLabel(period.fy)} revenue`, basis: "screener.in annual P&L" };
  }
  const q = seriesFrom(c.quarters, rev);
  const wanted = quarterKeys(period.fy, period.scope, period.quarter);
  const vals = wanted.map(q).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const total = vals.reduce((a, b) => a + b, 0);
  const complete = vals.length === wanted.length;
  return {
    value: total,
    complete,
    label: complete ? `${period.label} revenue` : `revenue in ${vals.length} of ${wanted.length} quarters of ${period.label}`,
    basis: "screener.in quarterly results",
    quartersReported: vals.length,
    quartersInPeriod: wanted.length,
  };
}

/** EBIT margin = (operating profit − depreciation) / sales, from the same standardised table. */
function ebitMarginFor(period: GuidancePeriod, c: StatementSet): Actual | null {
  const rev = ["sales", "revenue"];
  const sumKeys = (t: StatementTable, rows: string[], keys: string[]) => {
    const s = seriesFrom(t, rows);
    const vals = keys.map(s);
    return vals.every((v) => v != null) ? (vals as number[]).reduce((a, b) => a + b, 0) : null;
  };
  if (period.scope === "FY") {
    const k = [`${period.fy}-03-31`];
    const op = sumKeys(c.annual, ["operating profit"], k);
    const dep = sumKeys(c.annual, ["depreciation"], k);
    const sales = sumKeys(c.annual, rev, k);
    if (op != null && dep != null && sales) return { value: ((op - dep) / sales) * 100, complete: true, label: `${fyLabel(period.fy)} EBIT margin`, basis: STANDARDISED_EBIT };
  }
  const wanted = quarterKeys(period.fy, period.scope, period.quarter);
  const reported = wanted.filter((k) => seriesFrom(c.quarters, rev)(k) != null);
  if (!reported.length) return null;
  const op = sumKeys(c.quarters, ["operating profit"], reported);
  const dep = sumKeys(c.quarters, ["depreciation"], reported);
  const sales = sumKeys(c.quarters, rev, reported);
  if (op == null || dep == null || !sales) return null;
  const complete = reported.length === wanted.length;
  return {
    value: ((op - dep) / sales) * 100,
    complete,
    label: `EBIT margin, ${complete ? period.label : `${reported.length} of ${wanted.length} quarters of ${period.label}`}`,
    basis: STANDARDISED_EBIT,
  };
}

/** Margins are recomputed from standardised statements, so a company's own definition can differ slightly. */
const STANDARDISED_EBIT = "screener.in standardised P&L: (operating profit − depreciation) ÷ sales. Company-defined EBIT can differ by a few tenths.";
const STANDARDISED_EBITDA = "screener.in standardised P&L: operating profit ÷ sales. Company-defined EBITDA can differ by a few tenths.";

function actualFor(metric: GuidanceMetric, period: GuidancePeriod, c: StatementSet): Actual | null {
  if (metric === "revenue_target") return revenueFor(period, c);
  if (metric === "ebit_margin") return c.isLender ? null : ebitMarginFor(period, c);
  if (!["revenue_growth", "ebitda_growth", "pat_growth", "ebitda_margin"].includes(metric)) return null;
  if (c.isLender && (metric === "ebitda_margin" || metric === "ebitda_growth")) return null;
  const rev = ["sales", "revenue"];
  const rowsFor = metric === "pat_growth" ? ["net profit"] : metric === "revenue_growth" ? rev : ["operating profit"];
  const annualKey = `${period.fy}-03-31`;

  if (period.scope === "FY") {
    const a = seriesFrom(c.annual, rowsFor);
    const r = seriesFrom(c.annual, rev);
    const cur = a(annualKey);
    if (cur != null) {
      if (metric === "ebitda_margin") {
        const revenue = r(annualKey);
        if (revenue) return { value: (cur / revenue) * 100, complete: true, label: `${fyLabel(period.fy)} EBITDA margin`, basis: STANDARDISED_EBITDA };
      } else {
        const g = pctChange(cur, a(lastYear(annualKey)));
        if (g != null) return { value: g, complete: true, label: `${fyLabel(period.fy)} growth`, basis: "screener.in annual P&L" };
      }
    }
  }

  const q = seriesFrom(c.quarters, rowsFor);
  const qRev = seriesFrom(c.quarters, rev);
  const wanted = quarterKeys(period.fy, period.scope, period.quarter);
  const reported = wanted.filter((k) => q(k) != null);
  if (!reported.length) return null;
  const sumOf = (s: Series, keys: string[]) => {
    const vals = keys.map(s);
    return vals.every((v) => v != null) ? (vals as number[]).reduce((x, y) => x + y, 0) : null;
  };
  const complete = reported.length === wanted.length;
  const span = complete ? period.label : `${reported.length} of ${wanted.length} quarters of ${period.label}`;
  if (metric === "ebitda_margin") {
    const num = sumOf(q, reported);
    const den = sumOf(qRev, reported);
    if (num == null || !den) return null;
    return { value: (num / den) * 100, complete, label: `EBITDA margin, ${span}`, basis: STANDARDISED_EBITDA };
  }
  const now = sumOf(q, reported);
  const before = sumOf(q, reported.map(lastYear));
  const g = pctChange(now, before);
  if (g == null) return null;
  return { value: g, complete, label: `YoY growth, ${span}`, basis: "screener.in quarterly results" };
}

export function evaluate(stmt: Pick<GuidanceStatement, "metric" | "low" | "high" | "unit" | "period" | "quote" | "segment">, company: StatementSet): Verdict {
  const { metric, low, high, period } = stmt;
  if (!metric || !period || (low == null && high == null)) return { status: "not_comparable", basis: "Not a quantified target" };
  if (metric === "capex" || metric === "volume_growth" || metric === "other") {
    return { status: "not_comparable", basis: "Reported financials don't isolate this; check the next transcripts" };
  }
  if (stmt.segment || isSegmentScoped(stmt.quote)) {
    return { status: "not_comparable", basis: "Refers to one business, segment or order — FINN only checks company-wide figures" };
  }
  const actual = actualFor(metric, period, company);
  if (!actual) {
    const lenderNa = company.isLender && metric.startsWith("ebit");
    return lenderNa
      ? { status: "not_comparable", basis: "EBITDA/EBIT are not meaningful for lenders" }
      : { status: "pending", basis: `No reported numbers for ${period.label} yet` };
  }
  if (metric === "revenue_target") {
    const target = low ?? high!;
    if (actual.complete) {
      const status: Verdict["status"] = actual.value < target * 0.98 ? "missed" : high != null && actual.value > high * 1.02 ? "beat" : "delivered";
      return { status, actual: actual.value, actualLabel: actual.label, basis: actual.basis };
    }
    // Year in progress: compare with the pro-rated target. Seasonality makes this approximate.
    const share = (actual.quartersReported ?? 0) / (actual.quartersInPeriod ?? 4);
    const status: Verdict["status"] = actual.value >= target * share * 0.95 ? "on_track" : "behind";
    return { status, actual: actual.value, actualLabel: `${actual.label} (pro-rata target ₹${Math.round(target * share).toLocaleString("en-IN")} cr)`, basis: `${actual.basis}; run-rate check` };
  }
  const tol = metric === "ebitda_margin" || metric === "ebit_margin" ? 0.3 : 0.5;
  const below = low != null && actual.value < low - tol;
  const above = high != null && actual.value > high + tol;
  const status: Verdict["status"] = actual.complete ? (below ? "missed" : above ? "beat" : "delivered") : below ? "behind" : "on_track";
  return { status, actual: actual.value, actualLabel: actual.label, basis: actual.basis };
}

// ---------- 5. Revisions and scorecard -----------------------------------------------------

export function rangeLabel(s: Pick<GuidanceStatement, "low" | "high" | "unit">): string {
  const rupees = s.unit === "INR_cr";
  const f = (v: number) => (rupees ? `₹${v.toLocaleString("en-IN")}` : String(v));
  const u = rupees ? " cr" : "%";
  if (s.low != null && s.high != null) return s.low === s.high ? `${f(s.low)}${u}` : `${f(s.low)}–${f(s.high)}${u}`;
  if (s.low != null) return `≥${f(s.low)}${u}`;
  if (s.high != null) return `≤${f(s.high)}${u}`;
  return "unquantified";
}

/** The same promise repeated in one call (opening remarks, then Q&A) counts once. */
export function dedupeStatements(statements: GuidanceStatement[]): GuidanceStatement[] {
  const seen = new Set<string>();
  return [...statements]
    .sort((a, b) => a.callMonth.localeCompare(b.callMonth) || a.page - b.page)
    .filter((s) => {
      if (!s.metric) return true;
      const key = `${s.callMonth}|${s.metric}|${s.period?.label}|${s.low}|${s.high}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.callMonth.localeCompare(a.callMonth) || a.page - b.page);
}

export function detectRevisions(statements: GuidanceStatement[]): Revision[] {
  const groups = new Map<string, GuidanceStatement[]>();
  for (const s of statements) {
    if (!s.metric || !s.period || s.low == null || s.verdict?.status === "not_comparable" || s.voice === "analyst") continue;
    const key = `${s.metric}|${s.period.label}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: Revision[] = [];
  // A call's stance: an explicit raise/cut if it made one, else its first mention.
  const CHANGE = /\b(rais|upgrad|increas|revis|now expect|lower|cut|reduc|toned down)\w*/i;
  const stance = (calls: GuidanceStatement[]) => calls.find((s) => CHANGE.test(s.quote)) ?? [...calls].sort((a, b) => a.page - b.page)[0];
  for (const list of groups.values()) {
    const months = [...new Set(list.map((s) => s.callMonth))].sort();
    const byCall = months.map((m) => stance(list.filter((s) => s.callMonth === m)));
    for (let i = 1; i < byCall.length; i++) {
      const a = byCall[i - 1];
      const b = byCall[i];
      const mid = (s: GuidanceStatement) => ((s.low ?? 0) + (s.high ?? s.low ?? 0)) / 2;
      const direction = mid(b) > mid(a) ? "raised" : mid(b) < mid(a) ? "cut" : "maintained";
      out.push({ metric: b.metric!, period: b.period!.label, from: rangeLabel(a), to: rangeLabel(b), direction, fromCall: a.callLabel, toCall: b.callLabel });
    }
  }
  return out;
}

export function scorecard(statements: GuidanceStatement[]): Record<Verdict["status"], number> {
  const card: Record<Verdict["status"], number> = { delivered: 0, missed: 0, beat: 0, on_track: 0, behind: 0, pending: 0, not_comparable: 0 };
  for (const s of statements) if (s.verdict) card[s.verdict.status]++;
  return card;
}

export const METRIC_LABEL: Record<GuidanceMetric, string> = {
  revenue_target: "Revenue target",
  revenue_growth: "Revenue growth",
  ebitda_growth: "EBITDA growth",
  pat_growth: "PAT growth",
  ebitda_margin: "EBITDA margin",
  ebit_margin: "EBIT margin",
  volume_growth: "Volume growth",
  capex: "Capex",
  other: "Other target",
};
