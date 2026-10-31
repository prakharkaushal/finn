import type { NextRequest } from "next/server";
import { DATA_COOKIE, DataUnavailableError, getFundamentals, modeFor, providerSet } from "@/lib/data/service";
import { isQuarterEnd } from "@/lib/domain/periods";
import { resultsSnapshot } from "@/lib/domain/results";
import { normalizeTicker } from "@/lib/domain/ticker";

export const maxDuration = 30;

/** Headline QoQ/YoY numbers for one results filing, fetched lazily by the results card. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const ticker = normalizeTicker(sp.get("symbol") ?? "");
  const period = sp.get("period") ?? "";
  if (!ticker.ok) return Response.json({ error: ticker.error }, { status: 400 });
  if (!isQuarterEnd(period)) return Response.json({ error: "period must be a quarter-end date: YYYY-03-31, -06-30, -09-30 or -12-31" }, { status: 400 });
  try {
    const company = await getFundamentals(ticker.symbol, undefined, providerSet(modeFor(request.cookies.get(DATA_COOKIE)?.value)));
    return Response.json(
      {
        snapshot: resultsSnapshot(company, period),
        source: { label: "screener.in quarterly table (compiled from company filings)", url: `${company.url}#quarters` },
        provenance: company.source.mode,
        fetchedAt: company.source.retrievedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const status = err instanceof DataUnavailableError && err.noData ? 404 : 502;
    return Response.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status });
  }
}
