/** Announcement taxonomy from the ENAM reference document, shared by server and client. */

export const CATEGORIES = [
  "results",
  "M&A",
  "fund_raise",
  "management_change",
  "litigation",
  "insider_trading",
  "earnings_call",
  "investor_meetings",
  "credit_rating",
  "dividend",
  "bonus_split",
  "capex",
  "press_release",
  "postal_ballot",
  "agm_egm",
  "pledging",
  "unclassified",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  results: "Results",
  "M&A": "M&A",
  fund_raise: "Fund raise",
  management_change: "Management",
  litigation: "Litigation",
  insider_trading: "Insider trades",
  earnings_call: "Earnings call",
  investor_meetings: "Investor meets",
  credit_rating: "Credit rating",
  dividend: "Dividend",
  bonus_split: "Bonus / split",
  capex: "Capex",
  press_release: "Press release",
  postal_ballot: "Postal ballot",
  agm_egm: "AGM / EGM",
  pledging: "Pledging",
  unclassified: "Routine",
};

/** What the default investor wants to be interrupted for. Users change this in Settings. */
export const DEFAULT_ALERT_CATEGORIES: Category[] = ["results", "M&A", "management_change", "fund_raise", "litigation", "pledging"];

export type Tier = "attention" | "look" | "routine";

export const TIER_LABEL: Record<Tier, string> = {
  attention: "Needs attention",
  look: "Worth a look",
  routine: "Routine",
};

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
