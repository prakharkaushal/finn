import type { NextRequest } from "next/server";
import { DATA_COOKIE, getDirectory, modeFor, providerSet } from "@/lib/data/service";
import { displayName } from "@/lib/domain/names";
import { normalizeTicker, searchCompanies } from "@/lib/sources/nse-master";

/** Ticker search (?q=) and validation (?symbol=) against NSE's own equity master list. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  try {
    const directory = await getDirectory(undefined, providerSet(modeFor(request.cookies.get(DATA_COOKIE)?.value)));
    const symbolParam = sp.get("symbol");
    if (symbolParam != null) {
      const t = normalizeTicker(symbolParam);
      if (!t.ok) return Response.json({ valid: false, error: t.error });
      const hit = directory.index.bySymbol.get(t.symbol);
      return Response.json(
        hit
          ? { valid: true, symbol: hit.symbol, name: displayName(hit.name) }
          : { valid: false, error: `${t.symbol} is not on NSE's equity list (as of ${directory.source.retrievedAt.slice(0, 10)})` },
      );
    }
    const q = (sp.get("q") ?? "").slice(0, 40);
    const results = searchCompanies(directory.companies, q.replace(/\.(NS|BO)$/i, "")).map((c) => ({ symbol: c.symbol, name: displayName(c.name) }));
    return Response.json({ results, asOf: directory.source.retrievedAt, provenance: directory.source.mode });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Ticker list unavailable" }, { status: 502 });
  }
}
