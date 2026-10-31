/** Pure ticker helpers, safe to import from client components. */

export type TickerInput = { ok: true; symbol: string } | { ok: false; error: string };

/**
 * Accepts the forms people actually type — "reliance", "RELIANCE.NS", "NSE:RELIANCE",
 * "m&m.bo" — and returns a bare NSE symbol. Existence is checked separately.
 */
export function normalizeTicker(input: string): TickerInput {
  let s = input.trim().toUpperCase();
  s = s.replace(/^(NSE|BSE)\s*:\s*/, "");
  s = s.replace(/\.(NS|NSE|BO|BSE)$/, "");
  s = s.replace(/\s+/g, "");
  if (!s) return { ok: false, error: "Enter an NSE ticker, e.g. RELIANCE" };
  if (!/^[A-Z0-9][A-Z0-9&-]{0,19}$/.test(s)) {
    return { ok: false, error: `"${input.trim()}" is not a valid NSE symbol (letters, digits, & and - only)` };
  }
  return { ok: true, symbol: s };
}

/** Normalised company name used to match feed items ("Larsen &amp; Toubro Limited") to symbols. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&/g, " and ")
    .replace(/\b(limited|ltd|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]/g, "");
}
