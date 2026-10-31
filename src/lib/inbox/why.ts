import { roleRank } from "@/lib/domain/classify";
import { formatInr } from "@/lib/domain/numbers";
import type { MarketSignal, Thresholds } from "@/lib/domain/signals";
import type { XbrlDocument } from "@/lib/sources/xbrl";

/**
 * "Why it matters" — one factual line per inbox item. Built from the item's type plus the
 * structured facts the filing itself contains (roles, dates, amounts, dilution); generic
 * rationale follows the challenge's reference glossary. No advice, nothing invented.
 */

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

const ROLE_SHORT: [RegExp, string][] = [
  [/managing director\s*(and|&)\s*(chief executive officer|ceo)/i, "MD & CEO"],
  [/chief executive officer/i, "CEO"],
  [/chief financial officer/i, "CFO"],
  [/chief operating officer/i, "COO"],
  [/managing director/i, "MD"],
  [/whole[- ]?time director/i, "Whole-time director"],
  [/independent director/i, "Independent director"],
];

function shortRole(role: string) {
  for (const [re, s] of ROLE_SHORT) if (re.test(role)) return s;
  return role;
}

export function filingWhy(args: { subtype: string; xbrl?: XbrlDocument }): string | null {
  const d = args.xbrl?.details;
  switch (args.subtype) {
    case "results_filed":
      return "Quarterly numbers are out; the comparison with last quarter and last year is below.";
    case "results_scheduled":
      return "The results date is set; numbers follow on the day.";
    case "results_deck":
      return "Management's own slides on the quarter.";
    case "results_press":
      return "Management's summary of the quarter.";
    case "mgmt_key":
    case "mgmt_key_exit":
    case "mgmt_auditor_exit":
    case "mgmt_board":
    case "mgmt_other":
    case "mgmt_unknown": {
      if (d?.kind === "management" && d.people.length) {
        const lead = [...d.people].sort((a, b) => roleRank(b.role) - roleRank(a.role))[0];
        const leaving = /cessation|resign|retire/i.test(`${lead.changeType} ${lead.cessationCategory ?? ""}`);
        const when = lead.effectiveDate ? ` from ${shortDate(lead.effectiveDate)}` : "";
        if (args.subtype === "mgmt_auditor_exit") return `The auditor is resigning${when} — a governance red flag; read the stated reasons.`;
        if (leaving) {
          const reason = lead.detailedReasonGiven === false ? " The resignation letter gives no detailed reason." : "";
          return `${shortRole(lead.role)} leaving${when}.${reason}`;
        }
        if (args.subtype === "mgmt_key") return `New ${shortRole(lead.role)}${when}. The company's own profile of the appointee is below.`;
        return `${shortRole(lead.role)} change${when}.`;
      }
      // Without the structured disclosure, say what kind of change it is and where the names are.
      if (args.subtype === "mgmt_key" || args.subtype === "mgmt_key_exit") return "A change at the top of the company. The filing names the person and role.";
      if (args.subtype === "mgmt_auditor_exit") return "The auditor is resigning — a governance red flag; read the stated reasons.";
      if (args.subtype === "mgmt_board") return "A board change. The filing names the director.";
      if (args.subtype === "mgmt_other") return "A senior-management or compliance change below the top team.";
      return "A change in directors or senior management. The filing names who and in which role.";
    }
    case "ma_new":
      if (d?.kind === "deal" && d.deal.relatedParty) return "A related-party deal: check the price and terms against an arm's-length benchmark.";
      return "An acquisition or restructuring changes the business mix.";
    case "ma_update":
      if (d?.kind === "deal" && /complet/i.test(d.deal.update ?? "")) return `An earlier deal is now complete${d.deal.amountInr ? ` (${formatInr(d.deal.amountInr)})` : ""}.`;
      return "An update on a deal disclosed earlier.";
    case "ma_subsidiary":
      return "A new subsidiary — usually structural rather than material.";
    case "order_win": {
      const amount = d?.kind === "order" ? d.orders.reduce((s, o) => s + (o.amountInr ?? 0), 0) : 0;
      return amount > 0 ? `${formatInr(amount)} of new orders adds to revenue visibility.` : "New orders add to revenue visibility; the value is in the filing.";
    }
    case "equity_raise": {
      const dil = d?.kind === "capital" ? d.capital.dilutionPct : undefined;
      return dil != null ? `New shares raise the share count by ${dil.toFixed(2)}%, diluting existing holders.` : "New shares dilute existing holders; check the price and the use of funds.";
    }
    case "buyback":
      return "A buyback returns surplus cash to shareholders.";
    case "debt_raise":
      return "New borrowing through debt securities.";
    case "allotment":
      return "New securities were allotted.";
    case "rating_down":
      return "A rating downgrade raises borrowing costs and often flags stress.";
    case "rating_up":
      return "A rating upgrade signals stronger credit.";
    case "rating_affirm":
      return "The credit rating is unchanged.";
    case "insolvency":
      return "Insolvency, default or fraud proceedings — the highest-risk filing type.";
    case "regulatory":
      return "A regulatory order or penalty: check the amount and the business impact.";
    case "dispute":
      return "A legal dispute is disclosed: check the exposure.";
    case "pledge":
      return "Promoter pledges can force share sales if the price falls.";
    case "insider":
      return "A promoter or insider dealt in the company's shares.";
    case "dividend":
      return "Cash is being returned to shareholders.";
    case "bonus_split":
      return "The share count changes; no cash changes hands.";
    case "capex":
      return "New capacity or capital spending — future growth, funded by cash or debt.";
    case "call_transcript":
      return "Management's own words on the quarter — FINN uses these to check guidance.";
    case "agreement":
      return "A new agreement is disclosed.";
    default:
      return null;
  }
}

/** Plain-English headline for a price/volume alert: "Fell 6.2% · volume 3.4× average". */
export function marketHeadline(s: MarketSignal): string {
  const parts: string[] = [];
  for (const h of s.hits) {
    if (h.id === "price" && s.changePct != null) parts.push(`${s.changePct >= 0 ? "Rose" : "Fell"} ${Math.abs(s.changePct).toFixed(1)}%`);
    if (h.id === "volume" && s.volumeRatio != null) parts.push(`volume ${s.volumeRatio.toFixed(1)}× average`);
    if (h.id === "high52") parts.push("52-week high");
    if (h.id === "low52") parts.push("52-week low");
  }
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Which of the investor's own rules fired, in words. */
export function marketWhy(s: MarketSignal, t: Thresholds): string {
  const parts: string[] = [];
  if (s.hits.some((h) => h.id === "price")) parts.push(`moved more than your ±${t.pricePct}% rule`);
  if (s.hits.some((h) => h.id === "volume")) parts.push(`traded above your ${t.volumeMultiple}× ${t.lookback}-day volume rule`);
  if (s.hits.some((h) => h.id === "high52" || h.id === "low52")) parts.push(`closed at a 52-week ${s.hits.some((h) => h.id === "high52") ? "high" : "low"}`);
  const text = `In the session of ${shortDate(s.date)} it ${parts.join(" and ")}.`;
  return text;
}
