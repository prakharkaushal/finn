import type { Category } from "@/lib/domain/categories";
import type { XbrlDetails } from "@/lib/sources/xbrl";

/**
 * Deterministic triage of exchange filings. Rules run on the exchange's own subject line
 * and description; XBRL facts (when available) refine the score. Every score comes with
 * human-readable reasons so the investor can see why something was ranked where it is.
 */

export type Classification = {
  category: Category;
  subtype: string;
  score: number;
  reasons: string[];
  /**
   * What the classification rests on: parsed XBRL; the exchange's subject line; a specific subject
   * confirmed by the description ("Outcome of Board Meeting" + "financial results for…"); only
   * free-text keywords under a generic subject ("General Updates"); or nothing.
   */
  evidence: "structured" | "subject" | "combined" | "description" | "none";
};

type Rule = {
  test: (s: string, d: string) => boolean;
  category: Category;
  subtype: string;
  score: number;
  reason: string;
};

const has = (re: RegExp) => (s: string, d: string) => re.test(s) || re.test(d);
const subj = (re: RegExp) => (s: string) => re.test(s);
/** Catch-all subjects whose real meaning is only in the description. */
const GENERIC = /^(general updates|updates|press release|media release)$/;
const generic = (re: RegExp) => (s: string, d: string) => GENERIC.test(s) && re.test(d);
const CALL_SUBJECT = /analyst|con\. call|investor meet/;
const call = (re: RegExp) => (s: string, d: string) => (CALL_SUBJECT.test(s) || GENERIC.test(s)) && re.test(d);

const ROUTINE_SUBJECTS =
  /trading window|declaration of nav|certificate under sebi|redemption|payment of interest|security cover|monitoring agency|statement of deviation|utili[sz]ation of issue proceeds|regulation 50|regulation 51|loss of share|duplicate share|investor complaints|regulation 74|reg\.? 74|compliance certificate|secretarial compliance|business responsibility|\besg\b|brsr|shareholding pattern|reconciliation of share capital|closure of (register|book)|corporate governance|change in (registered office|name of rta)/;

/** How senior a role is. Drives both scoring and which person leads a card's headline. */
export function roleRank(role: string): number {
  const r = role.toLowerCase();
  if (/managing director|\bmd\b|chief executive|\bceo\b/.test(r)) return 100;
  if (/chief financial|\bcfo\b/.test(r)) return 90;
  if (/chair(man|person)?\b/.test(r)) return 85;
  if (/whole[- ]?time director|executive director|joint managing/.test(r)) return 80;
  if (/chief operating|\bcoo\b/.test(r)) return 75;
  if (/statutory auditor|\bauditor/.test(r)) return 70;
  if (/director/.test(r)) return 55;
  if (/chief|head|president|vice president/.test(r)) return 40;
  if (/company secretary|compliance officer/.test(r)) return 20;
  return 30;
}

const RULES: Rule[] = [
  { test: subj(ROUTINE_SUBJECTS), category: "unclassified", subtype: "routine", score: 3, reason: "Routine compliance filing" },

  // Results family — the reference groups decks, press releases and ads with results.
  { test: subj(/financial result|integrated filing.*financial/), category: "results", subtype: "results_filed", score: 90, reason: "Results filed" },
  {
    test: (s, d) => s.startsWith("outcome of board meeting") && /financial result|unaudited|audited|results for the (quarter|period|year)/.test(d),
    category: "results", subtype: "results_filed", score: 90, reason: "Results filed",
  },
  { test: (s, d) => s.startsWith("board meeting intimation") && /result/.test(d), category: "results", subtype: "results_scheduled", score: 30, reason: "Results date set" },
  { test: subj(/^outcome of board meeting/), category: "unclassified", subtype: "board_outcome", score: 28, reason: "Board meeting outcome" },
  { test: subj(/^board meeting intimation/), category: "unclassified", subtype: "board_intimation", score: 12, reason: "Board meeting scheduled" },
  { test: subj(/^investor presentation/), category: "results", subtype: "results_deck", score: 35, reason: "Investor presentation" },
  { test: (s, d) => /newspaper publication/.test(s) && /result/.test(d), category: "results", subtype: "results_ad", score: 4, reason: "Results newspaper ad (routine)" },
  { test: subj(/newspaper publication/), category: "unclassified", subtype: "routine", score: 3, reason: "Newspaper publication (routine)" },
  {
    test: (s, d) => /press release|media release/.test(s) && /financial result|results for the|quarter (and|&) (half|nine)|q[1-4]\s?fy/.test(d),
    category: "results", subtype: "results_press", score: 40, reason: "Results press release",
  },

  // ESOP grants hide under "General Updates" too.
  {
    test: (s, d) => /esop|esos|esps/.test(s) || ((/allotment/.test(s) || GENERIC.test(s)) && /esop|esos|esps|employee stock|stock option|restricted stock|\brsus?\b|grant of [\d,]+ options/.test(d)),
    category: "unclassified", subtype: "esop", score: 4, reason: "Employee stock options (routine)",
  },

  // Earnings calls vs one-on-one investor meetings.
  { test: call(/transcript/), category: "earnings_call", subtype: "call_transcript", score: 45, reason: "Earnings-call transcript" },
  { test: call(/recording|audio|video|link of/), category: "earnings_call", subtype: "call_recording", score: 18, reason: "Call recording" },
  { test: call(/earnings (conference )?call|conference call|con\.? ?call|investors'? call/), category: "earnings_call", subtype: "call_notice", score: 25, reason: "Earnings call scheduled" },
  { test: (s, d) => CALL_SUBJECT.test(s) || generic(/analyst|investors?\)? meet|institutional investor/)(s, d), category: "investor_meetings", subtype: "investor_meet", score: 12, reason: "Investor meeting" },

  // Insider/SAST before M&A so "acquisition of shares" disclosures are not read as deals.
  { test: has(/insider trading|\bsast\b|regulation 29|reg\.? 29|regulation 7\(|substantial acquisition|takeover regulations/), category: "insider_trading", subtype: "insider", score: 45, reason: "Insider / promoter dealing" },

  { test: has(/pledge|encumbrance/), category: "pledging", subtype: "pledge", score: 65, reason: "Promoter pledge change" },

  { test: subj(/^update.?-?.?acquisition|^update on (acquisition|merger)/), category: "M&A", subtype: "ma_update", score: 60, reason: "Update on a deal" },
  { test: has(/to be incorporated|incorporation of (a |an )?(new )?(wholly[- ]owned )?(step[- ]down )?subsidiar/), category: "M&A", subtype: "ma_subsidiary", score: 38, reason: "New subsidiary set up" },
  { test: has(/acquisition|amalgamation|merger|demerger|scheme of arrangement|joint venture|disposal|divest|slump sale|sale of (stake|undertaking|business|subsidiary)|restructuring/), category: "M&A", subtype: "ma_new", score: 85, reason: "Deal announced" },

  { test: has(/insolvency|\bcirp\b|\bnclt\b|default in|fraud/), category: "litigation", subtype: "insolvency", score: 90, reason: "Insolvency / default / fraud" },
  { test: has(/penalt|show cause|tax demand|orders passed|actions initiated|regulatory action|violation|search and seizure|investigation/), category: "litigation", subtype: "regulatory", score: 65, reason: "Regulatory action" },
  { test: has(/litigation|dispute|arbitration|lawsuit|petition/), category: "litigation", subtype: "dispute", score: 55, reason: "Litigation" },

  { test: has(/buy ?back/), category: "fund_raise", subtype: "buyback", score: 75, reason: "Buyback" },
  { test: has(/commercial paper|debenture|\bncds?\b|\bbonds?\b/), category: "fund_raise", subtype: "debt_raise", score: 30, reason: "Debt raise" },
  { test: has(/qualified institution|\bqip\b|preferential|rights issue|warrant|fund raising|raising of funds|issue of (equity|securities)|alteration of capital/), category: "fund_raise", subtype: "equity_raise", score: 75, reason: "Equity fund raise" },
  { test: subj(/allotment of securities/), category: "fund_raise", subtype: "allotment", score: 40, reason: "Allotment of securities" },

  { test: (s) => s.includes("credit rating"), category: "credit_rating", subtype: "rating", score: 40, reason: "Credit rating action" },

  { test: (s, d) => s.includes("dividend") || (s.startsWith("record date") && /dividend/.test(d)), category: "dividend", subtype: "dividend", score: 45, reason: "Dividend" },
  { test: has(/\bbonus\b|stock split|sub-?division/), category: "bonus_split", subtype: "bonus_split", score: 60, reason: "Bonus / split" },
  { test: subj(/^record date/), category: "unclassified", subtype: "record_date", score: 10, reason: "Record date" },

  { test: has(/capex|capital expenditure|capacity expansion|expansion of capacity|new plant|commercial production|commissioning|greenfield|brownfield/), category: "capex", subtype: "capex", score: 70, reason: "Capacity / capex" },

  { test: has(/postal ballot/), category: "postal_ballot", subtype: "postal_ballot", score: 20, reason: "Postal ballot" },
  { test: has(/shareholders meeting|general meeting|\bagm\b|\begm\b|court convened|scrutini[sz]er|voting results/), category: "agm_egm", subtype: "agm_egm", score: 20, reason: "Shareholder meeting" },

  // Management changes: role detection refines this below.
  { test: subj(/change in director|change in management|resignation|appointment|cessation|re-?appointment|kmp|\bdirector/), category: "management_change", subtype: "mgmt_unknown", score: 60, reason: "Management change" },

  { test: has(/bagging|receiving of orders|award of (an )?(order|contract)|letter of award|order win/), category: "press_release", subtype: "order_win", score: 65, reason: "Order win" },
  { test: subj(/press release|media release/), category: "press_release", subtype: "press", score: 40, reason: "Press release" },
  { test: subj(/agreement/), category: "press_release", subtype: "agreement", score: 45, reason: "Agreement signed" },
  { test: subj(/general updates|^updates$|clarification/), category: "press_release", subtype: "update", score: 25, reason: "Company update" },
];

function ratingAdjust(d: string): Pick<Classification, "subtype" | "score"> & { reason: string } {
  if (/downgrad|downward|revised down|negative watch|watch with negative|outlook.*negative/.test(d))
    return { subtype: "rating_down", score: 85, reason: "Rating downgrade" };
  if (/upgrad|upward|revised up|outlook.*positive/.test(d)) return { subtype: "rating_up", score: 60, reason: "Rating upgrade" };
  if (/reaffirm|affirm/.test(d)) return { subtype: "rating_affirm", score: 30, reason: "Rating reaffirmed" };
  return { subtype: "rating", score: 40, reason: "Credit rating action" };
}

function managementAdjust(description: string, xbrl?: XbrlDetails): Pick<Classification, "subtype" | "score"> & { reason: string } {
  const people = xbrl?.kind === "management" ? xbrl.people : [];
  if (people.length) {
    const top = [...people].sort((a, b) => roleRank(b.role) - roleRank(a.role))[0];
    const rank = roleRank(top.role);
    const exit = /cessation|resign|retire/i.test(`${top.changeType} ${top.cessationCategory ?? ""}`);
    if (rank === 70 && exit) return { subtype: "mgmt_auditor_exit", score: 85, reason: "Auditor resignation" };
    if (rank >= 75) {
      return exit
        ? { subtype: "mgmt_key_exit", score: 88, reason: `Key role exit: ${top.role}` }
        : { subtype: "mgmt_key", score: 80, reason: `Key role: ${top.role}` };
    }
    if (rank >= 55) return { subtype: "mgmt_board", score: 55, reason: "Board change" };
    return { subtype: "mgmt_other", score: 35, reason: "Senior-management / compliance change" };
  }
  // No XBRL: read the role from the description, ignoring the generic subject wording.
  const text = description.replace(/directors?\/kmp\/smp\/auditor\/rta/gi, "").replace(/change in director\(s\)/gi, "");
  const rank = roleRank(text);
  const exit = /resign|cessation|retire|step(s|ped)? down/i.test(text);
  if (rank >= 75) {
    return exit ? { subtype: "mgmt_key_exit", score: 88, reason: "Key role exit" } : { subtype: "mgmt_key", score: 80, reason: "Key role change" };
  }
  if (rank === 55) return { subtype: "mgmt_board", score: 55, reason: "Board change" };
  if (rank === 20 || rank === 40) return { subtype: "mgmt_other", score: 35, reason: "Senior-management / compliance change" };
  return { subtype: "mgmt_unknown", score: 60, reason: "Management change (roles in filing)" };
}

function capitalAdjust(xbrl?: XbrlDetails): (Pick<Classification, "subtype" | "score" | "category"> & { reason: string }) | null {
  if (xbrl?.kind !== "capital") return null;
  const type = (xbrl.capital.issuanceType ?? "").toLowerCase();
  if (/esop|esps|employee/.test(type)) return { category: "unclassified", subtype: "esop", score: 4, reason: "ESOP allotment (routine)" };
  if (/bonus/.test(type)) return { category: "bonus_split", subtype: "bonus_split", score: 60, reason: "Bonus issue" };
  if (/preferential|qip|qualified|rights|warrant/.test(type)) return { category: "fund_raise", subtype: "equity_raise", score: 75, reason: `Equity raise: ${xbrl.capital.issuanceType}` };
  return null;
}

export function classify(subject: string, description: string, xbrl?: XbrlDetails): Classification {
  const s = subject.toLowerCase().replace(/-xbrl$/, "").trim();
  const d = description.toLowerCase();
  const rule = RULES.find((r) => r.test(s, d));
  if (!rule) return { category: "unclassified", subtype: "other", score: 8, reasons: ["Unclassified filing"], evidence: "none" };

  let category = rule.category;
  let { subtype, score, reason } = rule;
  let evidence: Classification["evidence"] = rule.test(s, "") ? "subject" : GENERIC.test(s) ? "description" : "combined";
  if (category === "credit_rating") ({ subtype, score, reason } = ratingAdjust(d));
  if (category === "management_change") {
    ({ subtype, score, reason } = managementAdjust(description, xbrl));
    if (xbrl?.kind === "management" && xbrl.people.length) evidence = "structured";
  }
  if (category === "fund_raise") {
    const adj = capitalAdjust(xbrl);
    if (adj) {
      ({ category, subtype, score, reason } = adj);
      evidence = "structured";
    }
  }
  if ((category === "M&A" && xbrl?.kind === "deal") || (subtype === "order_win" && xbrl?.kind === "order")) evidence = "structured";
  const reasons = [reason];
  if (category === "M&A" && xbrl?.kind === "deal") {
    if (xbrl.deal.update) reasons[0] = `Deal update: ${xbrl.deal.update.toLowerCase()}`;
    if (xbrl.deal.relatedParty) {
      score += 5;
      reasons.push("Related-party deal");
    }
  }
  if (subtype === "order_win" && xbrl?.kind === "order" && xbrl.orders.some((o) => o.relatedParty)) reasons.push("Related-party order");
  return { category, subtype, score: Math.min(score, 100), reasons, evidence };
}
