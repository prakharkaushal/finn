import { lastCompletedQuarter, quarterEndFor } from "@/lib/domain/periods";

/** Deterministic extraction from the exchange's own description text. No model involved. */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthIndex(name: string): number {
  const n = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(n)) + 1;
}

function iso(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** Finds the first calendar date in a phrase, in the formats Indian filings actually use. */
export function findDate(text: string): string | null {
  const t = text.toLowerCase();
  let m = t.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+${MONTH_RE}[a-z]*[,\\s-]+(\\d{4})`));
  if (m) return iso(Number(m[3]), monthIndex(m[2]), Number(m[1]));
  m = t.match(new RegExp(`${MONTH_RE}[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`));
  if (m) return iso(Number(m[3]), monthIndex(m[1]), Number(m[2]));
  m = t.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m && Number(m[2]) <= 12) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

/** "results for the quarter and half year ended September 30, 2026" → "2026-09-30". */
export function resultsPeriodEnd(text: string, filedAt: string): string {
  const t = text.toLowerCase();
  const ended = t.match(/(?:quarter|period|half[- ]year|nine months|year)[^.]{0,40}?ended(?: on)?(?: the)?\s+([^|.;]{4,40})/);
  if (ended) {
    const date = findDate(ended[1]);
    if (date) {
      const [y, mo] = date.split("-").map(Number);
      return quarterEndFor(y, mo);
    }
    const monthYear = ended[1].match(new RegExp(`${MONTH_RE}[a-z]*,?\\s+(\\d{4})`));
    if (monthYear) return quarterEndFor(Number(monthYear[2]), monthIndex(monthYear[1]));
  }
  return lastCompletedQuarter(new Date(filedAt));
}

/** "Board Meeting to be held on 30-Oct-2026 to consider … results" → "2026-10-30". */
export function boardMeetingDate(text: string): string | null {
  const m = text.match(/(?:to be held on|scheduled (?:to be held )?on|meeting (?:of the board[^.]{0,40})?on)\s+([^.;]{6,40})/i);
  return m ? findDate(m[1]) : null;
}

/** "declared Interim Dividend of Rs. 7.70 per equity share" → { kind: "Interim", perShare: 7.7 }. */
export function dividendInfo(text: string): { kind?: string; perShare?: number } | null {
  const m = text.match(/(interim|final|special)?\s*dividend of\s*(?:rs\.?|₹|inr)\s*([\d.]+)/i);
  if (!m) return null;
  const kind = m[1] ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : undefined;
  return { kind, perShare: Number(m[2]) };
}

/** "Record date for the purpose of Buyback is 13-Nov-2026" → { purpose: "Buyback", date }. */
export function recordDateInfo(text: string): { purpose?: string; date: string } | null {
  const m = text.match(/record date(?: for the purpose of ([a-z ]+?))?\s+is\s+([^.]+)/i);
  if (!m) return null;
  const date = findDate(m[2]);
  return date ? { purpose: m[1]?.trim(), date } : null;
}

/** "Appointment of Ms Rinkoo Somani as Chief Financial Officer of the company w.e.f. …" */
export function appointmentFromText(text: string): { name: string; role: string } | null {
  const m = text.match(/appointment of\s+(.+?)\s+as\s+(.+?)(?:\s+of the company)?(?:\s+w\.?\s?e\.?\s?f\.?.*)?\.?$/i);
  if (!m) return null;
  // Feeds sometimes double the salutation ("Mr Mr. Santosh …"); keep the last one.
  const name = m[1].replace(/^((mr|ms|mrs|dr|shri|smt)\.?\s+)+/i, (s) => `${s.trim().split(/\s+/).pop()} `).trim();
  const role = m[2].replace(/\s+/g, " ").trim();
  if (!name || name.length > 60) return null;
  return { name, role: /^other$/i.test(role) ? "Not specified" : role };
}

/**
 * Strips "<Company> has informed the Exchange about/regarding/that" boilerplate. Returns
 * null when what is left only restates the subject — then the filing itself is the summary.
 */
export function informativeText(description: string, subject: string): string | null {
  let t = description
    .replace(/^.*?has (?:informed|submitted to|filed with) (?:the )?exchanges?(?:,)?\s*(?:about|regarding|that|the)?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  // Some feed items carry only the XBRL form name as their description.
  if (!t || /-xbrl$/i.test(t)) return null;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, "");
  const body = norm(t.replace(/of the company\.?$/i, ""));
  const subj = norm(subject.replace(/-xbrl$/i, ""));
  if (!body || body === subj || (subj.length > 6 && subj.includes(body)) || (body.length > 6 && body.includes(subj) && body.length - subj.length < 12)) {
    return null;
  }
  return t.length > 240 ? `${t.slice(0, 237).trimEnd()}…` : t;
}
