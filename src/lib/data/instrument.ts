/** A listing FINN can price: an NSE or BSE trading symbol. Pure helpers, safe in client components. */

export type Exchange = "NSE" | "BSE";
export type Instrument = { exchange: Exchange; code: string };
export type InstrumentInput = { ok: true; instrument: Instrument } | { ok: false; error: string };

const CODE = /^[A-Z0-9][A-Z0-9&-]{0,19}$/;

/**
 * "reliance", "RELIANCE.NS", "NSE:RELIANCE" → NSE RELIANCE; "TCS.BO", "bse:tcs" → BSE TCS.
 * Six-digit BSE scrip codes are refused with a hint: the price sources FINN uses only accept
 * trading symbols (Yahoo answers 500325.BO with "not found").
 */
export function parseInstrument(input: string): InstrumentInput {
  const raw = input.trim();
  let s = raw.toUpperCase().replace(/\s+/g, "");
  let exchange: Exchange = "NSE";
  const prefix = s.match(/^(NSE|BSE):/);
  if (prefix) {
    exchange = prefix[1] as Exchange;
    s = s.slice(prefix[0].length);
  }
  const suffix = s.match(/\.(NS|NSE|BO|BSE)$/);
  if (suffix) {
    const fromSuffix: Exchange = suffix[1].startsWith("N") ? "NSE" : "BSE";
    if (prefix && fromSuffix !== exchange) return { ok: false, error: `"${raw}" names two different exchanges` };
    exchange = fromSuffix;
    s = s.slice(0, -suffix[0].length);
  }
  if (!s) return { ok: false, error: "Enter a ticker, e.g. RELIANCE or TCS.BO" };
  if (/^\d{6}$/.test(s)) {
    return { ok: false, error: `${s} looks like a BSE scrip code; use the trading symbol instead (e.g. RELIANCE.BO)` };
  }
  if (!CODE.test(s)) return { ok: false, error: `"${raw}" is not a valid symbol (letters, digits, & and - only)` };
  return { ok: true, instrument: { exchange, code: s } };
}

/** Yahoo Finance's convention: RELIANCE.NS on NSE, RELIANCE.BO on BSE. */
export function yahooSymbol(i: Instrument): string {
  return `${i.code}${i.exchange === "NSE" ? ".NS" : ".BO"}`;
}

/** Stable cache/record key: "NSE:RELIANCE". */
export function instrumentKey(i: Instrument): string {
  return `${i.exchange}:${i.code}`;
}

/** URL form used by the research route: bare for NSE, ".BO" suffix for BSE. */
export function instrumentSlug(i: Instrument): string {
  return i.exchange === "NSE" ? i.code : `${i.code}.BO`;
}
