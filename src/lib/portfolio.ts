/**
 * The mock portfolio: 20 NSE companies across sectors and sizes, chosen so a results-season
 * day shows a realistic mix (results, management changes, deals, quiet names). Nothing in
 * the engine depends on this list — users replace it in Settings with any NSE symbols.
 */
export const DEFAULT_PORTFOLIO: { symbol: string; sector: string }[] = [
  { symbol: "RELIANCE", sector: "Energy, telecom & retail" },
  { symbol: "HDFCBANK", sector: "Private bank" },
  { symbol: "BHARTIARTL", sector: "Telecom" },
  { symbol: "LT", sector: "Engineering & construction" },
  { symbol: "ITC", sector: "FMCG" },
  { symbol: "MARUTI", sector: "Passenger vehicles" },
  { symbol: "BAJAJ-AUTO", sector: "Two-wheelers" },
  { symbol: "CIPLA", sector: "Pharma" },
  { symbol: "HCLTECH", sector: "IT services" },
  { symbol: "BAJFINANCE", sector: "Consumer finance" },
  { symbol: "TRENT", sector: "Retail" },
  { symbol: "ETERNAL", sector: "Food delivery & quick commerce" },
  { symbol: "TATAPOWER", sector: "Power" },
  { symbol: "HAVELLS", sector: "Consumer electricals" },
  { symbol: "DIXON", sector: "Electronics manufacturing" },
  { symbol: "POLYCAB", sector: "Cables & wires" },
  { symbol: "SYNGENE", sector: "Contract research (CRDMO)" },
  { symbol: "KPITTECH", sector: "Automotive software" },
  { symbol: "DEEPAKNTR", sector: "Chemicals" },
  { symbol: "HOMEFIRST", sector: "Affordable housing finance" },
];

/** Ad-hoc research demos, outside the portfolio. Any NSE symbol works in the search box. */
export const RESEARCH_PICKS = ["PIDILITIND", "KAYNES", "ASIANPAINT", "COFORGE"];

export const MAX_PORTFOLIO = 30;
