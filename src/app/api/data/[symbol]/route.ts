import type { NextRequest } from "next/server";
import { periodValues } from "@/lib/data/adapters/screener";
import { parseInstrument } from "@/lib/data/instrument";
import { DATA_COOKIE, dataNow, getAnnouncements, getDirectory, getFundamentals, getPrices, modeFor, providerSet } from "@/lib/data/service";

export const maxDuration = 30;

const HEADLINE = ["revenue", "ebitda", "pbt", "pat"];

/**
 * Debug view of the canonical records for one listing — company, prices, announcements,
 * statements and primary documents — each with its source, retrieval time and mode, plus the
 * error from every provider that failed. /api/data/RELIANCE, /api/data/TCS.BO?days=30
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/data/[symbol]">) {
  const { symbol } = await ctx.params;
  const parsed = parseInstrument(decodeURIComponent(symbol));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const instrument = parsed.instrument;
  const days = Math.min(30, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 7));
  const set = providerSet(modeFor(request.cookies.get(DATA_COOKIE)?.value));
  const now = await dataNow(set);

  const [directory, prices, fundamentals] = await Promise.allSettled([getDirectory(undefined, set), getPrices(instrument, undefined, set), getFundamentals(instrument.code, undefined, set)]);
  const listed = directory.status === "fulfilled" ? (directory.value.index.bySymbol.get(instrument.code) ?? null) : null;
  const outcomes =
    directory.status === "fulfilled" && listed
      ? await getAnnouncements({ symbols: [instrument.code], from: now - days * 86_400_000, to: now, directory: directory.value }, undefined, set)
      : [];
  const fail = (r: PromiseRejectedResult) => ({ error: r.reason instanceof Error ? r.reason.message : String(r.reason) });

  return Response.json(
    {
      dataMode: set.mode,
      instrument,
      company:
        directory.status === "fulfilled"
          ? listed
            ? { ...listed, exchange: "NSE", source: directory.value.source }
            : { error: `${instrument.code} is not on NSE's equity list` }
          : fail(directory),
      prices:
        prices.status === "fulfilled"
          ? { ...prices.value, sessions: prices.value.bars.length, bars: prices.value.bars.slice(-5) }
          : fail(prices),
      announcements: outcomes.map((o) =>
        o.ok
          ? { provider: o.provider.id, source: o.batch.source, coverage: o.batch.coverage[instrument.code] ?? o.batch.coverage["*"] ?? [], issues: o.batch.issues, items: o.batch.items.filter((a) => a.symbol === instrument.code && Date.parse(a.ts) >= now - days * 86_400_000).map(({ xbrl, ...a }) => ({ ...a, hasXbrl: Boolean(xbrl) })) }
          : { provider: o.provider.id, error: o.error },
      ),
      fundamentals:
        fundamentals.status === "fulfilled"
          ? {
              source: fundamentals.value.source,
              basis: fundamentals.value.basis,
              units: fundamentals.value.units,
              issues: fundamentals.value.issues,
              headlineQuarterly: HEADLINE.flatMap((m) => periodValues(fundamentals.value).filter((v) => v.statement === "quarterly" && v.metric === m).slice(-4)),
              documents: fundamentals.value.documents,
            }
          : fail(fundamentals),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
