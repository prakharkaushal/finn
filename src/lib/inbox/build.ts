import { CATEGORY_LABEL, type Category, type Tier } from "@/lib/domain/categories";
import { classify, roleRank, type Classification } from "@/lib/domain/classify";
import { dilutionMagnitude, filingMateriality, resultsMagnitude, sizeVsRevenue, type Confidence, type Magnitude } from "@/lib/domain/materiality";
import type { ResultsSnapshot } from "@/lib/domain/results";
import {
  appointmentFromText,
  boardMeetingDate,
  dividendInfo,
  informativeText,
  recordDateInfo,
  resultsPeriodEnd,
} from "@/lib/domain/extract";
import { formatInr } from "@/lib/domain/numbers";
import { quarterOf } from "@/lib/domain/periods";
import { istDate } from "@/lib/domain/signals";
import type { XbrlDocument, PersonChange } from "@/lib/sources/xbrl";
import type { ArchivedAnnouncement } from "@/lib/inbox/archive";
import type { FilingDoc, FilingItem, ItemProvenance, ResultsAttachment, Upcoming } from "@/lib/inbox/types";
import { filingWhy } from "@/lib/inbox/why";

/**
 * Turns raw exchange filings into inbox cards: one card per company-event-day, so a results
 * day (outcome PDF + XBRL + deck + press release + newspaper ad) is one item, not five.
 */

const TIER_RANK: Record<Tier, number> = { attention: 0, look: 1, routine: 2 };

export function sortItems<T extends { tier: Tier; score: number; ts: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score || b.ts.localeCompare(a.ts));
}

const ROLE_ABBREVIATIONS: [RegExp, string][] = [
  [/managing director\s*(and|&)\s*(chief executive officer|ceo)/i, "MD & CEO"],
  [/chief executive officer/i, "CEO"],
  [/chief financial officer/i, "CFO"],
  [/chief operating officer/i, "COO"],
  [/chief technology officer/i, "CTO"],
  [/chief risk officer/i, "CRO"],
  [/managing director/i, "MD"],
  [/whole[- ]?time director/i, "Whole-time director"],
  [/independent director/i, "Independent director"],
  [/non[- ]?executive director/i, "Non-executive director"],
  [/company secretary/i, "Company secretary"],
];

export function shortRole(role: string): string {
  for (const [re, abbr] of ROLE_ABBREVIATIONS) if (re.test(role)) return abbr;
  return role.length > 42 ? `${role.slice(0, 40).trimEnd()}…` : role;
}

function verbFor(p: PersonChange): string {
  const t = `${p.changeType} ${p.cessationCategory ?? ""}`.toLowerCase();
  if (t.includes("re-appointment") || t.includes("reappointment")) return "re-appointed";
  if (t.includes("appointment")) return "appointed";
  if (t.includes("resignation")) return "resigns";
  if (t.includes("retire")) return "retires";
  if (t.includes("designation")) return "redesignated";
  if (t.includes("cessation")) return "steps down";
  return "changes";
}

function managementHeadline(people: PersonChange[]): string {
  const lead = [...people].sort((a, b) => roleRank(b.role) - roleRank(a.role))[0];
  const leadLine = `${shortRole(lead.role)} ${verbFor(lead)}: ${lead.name}`;
  return people.length === 1 ? leadLine : `${leadLine} · +${people.length - 1} more`;
}

function fmtDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00+05:30`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

function cleanSubject(subject: string): string {
  return subject.replace(/-XBRL$/i, "").replace(/\s*\((sub-para|para)[^)]*\)\s*$/i, "").trim();
}

type Described = Pick<FilingItem, "headline" | "facts" | "results">;

function describe(primary: ArchivedAnnouncement, c: Classification, xbrl: XbrlDocument | undefined, symbol: string): Described {
  const facts: { label: string; value: string }[] = [];
  const text = primary.description;
  const details = xbrl?.details;

  if (c.category === "results") {
    if (c.subtype === "results_filed") {
      const periodEnd = resultsPeriodEnd(text, primary.ts);
      const q = quarterOf(periodEnd);
      const label = q?.label ?? "Quarterly";
      return { headline: `${label} results`, facts, results: { periodEnd, quarterLabel: label } };
    }
    if (c.subtype === "results_scheduled") {
      const date = boardMeetingDate(text);
      if (date) facts.push({ label: "Board meets", value: fmtDate(date) });
      return { headline: date ? `Results due ${fmtDate(date)}` : "Results date announced", facts };
    }
    const label = { results_deck: "Investor presentation", results_press: "Results press release", results_ad: "Results newspaper ad" }[c.subtype];
    return { headline: label ?? "Results update", facts };
  }

  if (c.category === "management_change") {
    if (details?.kind === "management" && details.people.length) {
      for (const p of details.people.slice(0, 3)) {
        if (p.effectiveDate) facts.push({ label: `${shortRole(p.role)} effective`, value: fmtDate(p.effectiveDate) });
      }
      return { headline: managementHeadline(details.people), facts };
    }
    const appt = appointmentFromText(text);
    if (appt) return { headline: `${shortRole(appt.role)} appointed: ${appt.name}`, facts };
    return { headline: cleanSubject(primary.subject) || "Management change", facts };
  }

  if (c.subtype === "order_win" && details?.kind === "order" && details.orders.length) {
    const total = details.orders.reduce((s, o) => s + (o.amountInr ?? 0), 0);
    const o = details.orders[0];
    if (o.counterparty) facts.push({ label: "From", value: o.counterparty });
    if (o.executionPeriod) facts.push({ label: "Execution", value: o.executionPeriod });
    if (o.relatedParty != null) facts.push({ label: "Related party", value: o.relatedParty ? "Yes" : "No" });
    const value = total > 0 ? formatInr(total) : o.consideration;
    return { headline: value ? `Order win · ${value}` : "Order win", facts };
  }

  if (c.category === "M&A" && details?.kind === "deal") {
    const d = details.deal;
    if (d.amountInr) facts.push({ label: "Amount", value: formatInr(d.amountInr) });
    if (d.completedOn) facts.push({ label: "Completed", value: fmtDate(d.completedOn) });
    if (d.consideration) facts.push({ label: "Consideration", value: d.consideration });
    if (d.relatedParty != null) facts.push({ label: "Related party", value: d.relatedParty ? "Yes" : "No" });
    if (d.completion) facts.push({ label: "Completion", value: d.completion });
    const event = d.eventType?.replace(/\s*\(including agreement to acquire\)/i, "") ?? "Deal";
    if (d.update) return { headline: `${event} update: ${d.update.toLowerCase()}`, facts };
    return { headline: d.target ? `${event}: ${d.target}` : event, facts };
  }

  if (details?.kind === "capital") {
    const cap = details.capital;
    if (cap.issuanceType) facts.push({ label: "Issue type", value: cap.issuanceType });
    if (cap.dilutionPct != null) facts.push({ label: "Share count change", value: `+${cap.dilutionPct < 0.01 ? cap.dilutionPct.toFixed(4) : cap.dilutionPct.toFixed(2)}%` });
    if (c.subtype === "esop") return { headline: "ESOP share allotment", facts };
  }

  if (c.category === "earnings_call" || c.category === "investor_meetings") {
    const label = { call_transcript: "Earnings-call transcript", call_recording: "Earnings-call recording", call_notice: "Earnings call scheduled" }[c.subtype];
    return { headline: label ?? "Analyst / investor meeting", facts };
  }

  if (c.subtype === "esop") return { headline: "Employee stock options", facts };

  if (c.category === "press_release" && c.subtype !== "order_win") {
    const title = text.match(/titled\s+["“'](.+?)["”']/i)?.[1];
    if (title) return { headline: title.length > 110 ? `${title.slice(0, 107).trimEnd()}…` : title, facts };
  }

  if (details?.kind === "generic") facts.push(...details.fields.slice(0, 4));

  if (c.category === "dividend") {
    const div = dividendInfo(text);
    const rec = recordDateInfo(text);
    if (rec) facts.push({ label: "Record date", value: fmtDate(rec.date) });
    if (div?.perShare != null) return { headline: `${div.kind ? `${div.kind} dividend` : "Dividend"} ₹${div.perShare}/share`, facts };
    return { headline: "Dividend", facts };
  }

  if (c.subtype === "record_date") {
    const rec = recordDateInfo(text);
    if (rec) return { headline: `Record date ${fmtDate(rec.date)}${rec.purpose ? ` · ${rec.purpose}` : ""}`, facts };
  }

  if (c.category === "credit_rating") return { headline: c.reasons[0] ?? "Credit rating", facts };

  const subject = cleanSubject(primary.subject);
  return { headline: subject || CATEGORY_LABEL[c.category] || `${symbol} filing`, facts };
}

function toDoc(a: ArchivedAnnouncement): FilingDoc {
  return { title: cleanSubject(a.subject) || "Filing", url: a.url, ts: a.ts, docType: a.docType, exchange: a.exchange };
}

const DOC_PREFERENCE = { pdf: 0, zip: 1, other: 2, xbrl: 3 } as const;

/** Data the scorer needs beyond the filings themselves, gathered by the caller. */
export type BuildContext = {
  /** Results numbers per "SYMBOL:periodEnd", with their source (snapshot null = statements unavailable). */
  results?: ReadonlyMap<string, ResultsAttachment>;
  /** Last four quarters of revenue per symbol, ₹ crore, to size orders and deals. */
  ttmRevenue?: ReadonlyMap<string, number | null>;
  /** Price/volume alerts per symbol: session date and what moved. */
  marketMoves?: ReadonlyMap<string, { date: string; label: string }[]>;
};

export type BuildFilingsInput = {
  announcements: ArchivedAnnouncement[];
  names: Map<string, string>;
  alertCategories: ReadonlySet<Category>;
  windowFrom: number;
  now: number;
  /** Provenance of the source each filing came from (live listing vs archive vs demo). */
  sourceOf?: (a: ArchivedAnnouncement) => { provenance: ItemProvenance; asOf: string };
  context?: BuildContext;
};

/** Kinds of filing that are, by nature, updates on something already filed. */
const FOLLOW_UP_KINDS = new Set(["ma_update", "update", "call_notice", "call_recording", "results_scheduled", "rating_affirm"]);

function confidenceFor(c: Classification, opts: { provenance: ItemProvenance; resultsMissing: boolean }): Confidence {
  const reasons: string[] = [];
  let level: Confidence["level"] = "high";
  const lower = (to: Confidence["level"], reason: string) => {
    if (to === "low" || (to === "medium" && level === "high")) level = to;
    reasons.unshift(reason);
  };
  if (c.evidence === "structured") reasons.push("Structured XBRL data from the filing");
  else if (c.evidence === "subject") reasons.push("Classified from the exchange's subject line");
  else if (c.evidence === "combined") reasons.push("Classified from the exchange's subject line and description");
  else if (c.evidence === "description") lower("medium", "Classified from the description; the subject line was generic");
  else lower("low", "No rule matched this filing");
  if (opts.provenance === "stale") lower("medium", "The listing was served from an older copy");
  if (opts.resultsMissing) lower("medium", "Results numbers not found in the source yet");
  return { level, reasons };
}

function magnitudeFor(c: Classification, xbrl: XbrlDocument | undefined, symbol: string, results: ResultsSnapshot | null | undefined, ctx: BuildContext): Magnitude | null {
  const details = xbrl?.details;
  if (c.subtype === "results_filed") return resultsMagnitude(results);
  if (c.subtype === "order_win" && details?.kind === "order") {
    return sizeVsRevenue("Order", details.orders.reduce((s, o) => s + (o.amountInr ?? 0), 0), ctx.ttmRevenue?.get(symbol));
  }
  if (c.category === "M&A" && details?.kind === "deal" && c.subtype !== "ma_subsidiary") return sizeVsRevenue("Deal", details.deal.amountInr, ctx.ttmRevenue?.get(symbol));
  if (details?.kind === "capital") return dilutionMagnitude(details.capital.dilutionPct);
  return null;
}

function corroborationFor(symbol: string, day: string, ctx: BuildContext): string | null {
  // The session of the filing day, or one of the next few if the filing came after the close.
  const limit = istDate(Date.parse(`${day}T12:00:00+05:30`) + 4 * 86_400_000);
  const move = ctx.marketMoves?.get(symbol)?.find((m) => m.date >= day && m.date <= limit);
  return move ? `Shares also tripped your rule: ${move.label.charAt(0).toLowerCase()}${move.label.slice(1)} (${fmtDate(move.date)} session)` : null;
}

type Group = { key: string; symbol: string; day: string; family: string; members: { a: ArchivedAnnouncement; c: Classification }[] };

export function buildFilingItems(input: BuildFilingsInput): { items: FilingItem[]; upcoming: Upcoming[] } {
  const { announcements, names, alertCategories, windowFrom, now } = input;
  const ctx = input.context ?? {};
  const sourceOf =
    input.sourceOf ??
    ((a: ArchivedAnnouncement) => ({ provenance: (a.via === "nse-rss" || a.via === "nse-api" ? "live" : "snapshot") as ItemProvenance, asOf: new Date(now).toISOString() }));
  const groups = new Map<string, Group>();
  /** "SYMBOL:day" → the results group filed that day (keyed by quarter, not by day). */
  const resultsByDay = new Map<string, string>();

  for (const a of announcements) {
    if (!a.symbol) continue;
    const t = Date.parse(a.ts);
    if (!(t >= windowFrom && t <= now + 60_000)) continue;
    const c = classify(a.subject, a.description, a.xbrl?.details);
    // Routine filings only bundle with the same kind of routine filing.
    const family = c.category === "unclassified" ? `unclassified-${c.subtype}` : c.category;
    const day = istDate(t);
    // One results event per company and quarter, even when its documents straddle midnight.
    const key = c.subtype === "results_filed" ? `${a.symbol}:results:q${resultsPeriodEnd(a.description, a.ts)}` : `${a.symbol}:${family}:${day}`;
    if (c.subtype === "results_filed") resultsByDay.set(`${a.symbol}:${day}`, key);
    const g = groups.get(key) ?? { key, symbol: a.symbol, day, family, members: [] };
    g.members.push({ a, c });
    groups.set(key, g);
  }

  // A results-day deck, press release or board-meeting outcome belongs to that day's results card.
  for (const [key, g] of groups) {
    const resultsKey = resultsByDay.get(`${g.symbol}:${g.day}`);
    if (!resultsKey || resultsKey === key) continue;
    const attach = g.family === "results" || g.members.every((m) => m.c.subtype === "board_outcome");
    const target = groups.get(resultsKey);
    if (!attach || !target) continue;
    target.members.push(...g.members.map((m) => (m.c.subtype === "board_outcome" ? { ...m, c: { ...m.c, score: 0 } } : m)));
    groups.delete(key);
  }

  // Follow-ups: a later bundle of the same kind (or with the same headline) for the same company.
  const seen = new Set<string>();
  const firstTs = (g: Group) => g.members.reduce((t, m) => (m.a.ts < t ? m.a.ts : t), g.members[0].a.ts);
  const ordered = [...groups.values()].sort((x, y) => firstTs(x).localeCompare(firstTs(y)));

  const items: FilingItem[] = [];
  for (const g of ordered) {
    const members = [...g.members].sort(
      (x, y) => y.c.score - x.c.score || DOC_PREFERENCE[x.a.docType] - DOC_PREFERENCE[y.a.docType] || y.a.ts.localeCompare(x.a.ts),
    );
    const xbrl = members.find((m) => m.a.xbrl && m.a.xbrl.details.kind !== "generic")?.a.xbrl ?? members.find((m) => m.a.xbrl)?.a.xbrl;
    const head = members[0];
    // Re-classify with the bundle's structured facts: actual roles from XBRL outrank the
    // generic wording of the PDF's subject line.
    const best = classify(head.a.subject, head.a.description, xbrl?.details);
    const primaryMember = members.find((m) => m.a.docType === "pdf" && m.c.category === head.c.category) ?? head;
    const primary = primaryMember.a;
    const symbol = primary.symbol!;
    const described = describe(head.a, best, xbrl, symbol);
    const source = sourceOf(primary);
    const latestTs = members.reduce((latest, m) => (m.a.ts > latest ? m.a.ts : latest), primary.ts);

    const kindKey = `${symbol}:${best.subtype}`;
    const headlineKey = `${symbol}:${described.headline}`;
    const followUp = (FOLLOW_UP_KINDS.has(best.subtype) && seen.has(kindKey)) || seen.has(headlineKey);
    seen.add(kindKey);
    seen.add(headlineKey);

    const resultsKey = described.results ? `${symbol}:${described.results.periodEnd}` : null;
    const attached = resultsKey ? ctx.results?.get(resultsKey) : undefined;
    const snapshot = attached?.snapshot;
    const m = filingMateriality({
      classification: best,
      magnitude: magnitudeFor(best, xbrl, symbol, snapshot, ctx),
      ageHours: (now - Date.parse(latestTs)) / 3_600_000,
      followUp,
      onAlertList: alertCategories.has(best.category),
      corroboration: best.score >= 30 ? corroborationFor(symbol, g.day, ctx) : null,
      confidence: confidenceFor(best, { provenance: source.provenance, resultsMissing: best.subtype === "results_filed" && attached !== undefined && snapshot?.status !== "ok" }),
    });

    items.push({
      kind: "filing",
      id: g.key,
      symbol,
      companyName: names.get(symbol) ?? primary.companyName,
      ts: latestTs,
      category: best.category,
      subtype: best.subtype,
      ...described,
      ...(described.results && attached ? { results: { ...described.results, attached } } : {}),
      why: m.tier === "routine" ? null : filingWhy({ subtype: best.subtype, xbrl }),
      summary: informativeText(head.a.description, head.a.subject),
      score: m.score,
      tier: m.tier,
      triggered: m.triggered,
      reasons: m.triggered ? [...best.reasons, "On your alert list"] : best.reasons,
      materiality: { components: m.components, confidence: m.confidence },
      primary: toDoc(primary),
      related: members.filter((x) => x.a !== primary).map((x) => toDoc(x.a)).sort((x, y) => y.ts.localeCompare(x.ts)),
      via: primary.via,
      provenance: source.provenance,
      asOf: source.asOf,
      xbrl,
    });
  }

  return { items: sortItems(items), upcoming: upcomingResults(announcements, names, now) };
}

/** Results dates announced in intimations (any time back), still in the future. */
export function upcomingResults(announcements: ArchivedAnnouncement[], names: Map<string, string>, now: number): Upcoming[] {
  const today = istDate(now);
  const bySymbol = new Map<string, Upcoming>();
  for (const a of announcements) {
    if (!a.symbol) continue;
    const c = classify(a.subject, a.description);
    if (c.subtype !== "results_scheduled") continue;
    const date = boardMeetingDate(a.description);
    if (!date || date < today) continue;
    const prev = bySymbol.get(a.symbol);
    if (!prev || date < prev.date) {
      bySymbol.set(a.symbol, { symbol: a.symbol, companyName: names.get(a.symbol) ?? a.companyName, date, label: "Results", url: a.url });
    }
  }
  return [...bySymbol.values()].sort((x, y) => x.date.localeCompare(y.date));
}
