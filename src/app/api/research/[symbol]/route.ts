import type { NextRequest } from "next/server";
import { parseInstrument } from "@/lib/data/instrument";
import { DATA_COOKIE, modeFor, providerSet } from "@/lib/data/service";
import { parseExtras } from "@/lib/research/discover";
import { getReport } from "@/lib/research/pipeline";
import type { ResearchEvent } from "@/lib/research/types";

// Reading an annual report and four transcripts can take a while on a cold cache.
export const maxDuration = 60;

/**
 * Streams progress as NDJSON (one event per line), ending with the report or an error.
 * RELIANCE or TCS.BO. ?refresh=1 rebuilds; ?extra=[{url,kind,period}] adds up to three documents.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/research/[symbol]">) {
  const { symbol: raw } = await ctx.params;
  const ticker = parseInstrument(decodeURIComponent(raw));
  if (!ticker.ok) return Response.json({ error: ticker.error }, { status: 400 });
  const sp = request.nextUrl.searchParams;
  const refresh = sp.get("refresh") === "1";
  const { extras, errors } = parseExtras(sp.get("extra"));
  const set = providerSet(modeFor(request.cookies.get(DATA_COOKIE)?.value));
  if (errors.length && !extras.length) return Response.json({ error: errors.join("; ") }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ResearchEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      for (const message of errors) send({ type: "step", id: "added-sources", label: "Checking the documents you added", status: "error", detail: message });
      try {
        const report = await getReport(ticker.instrument, { refresh, emit: send, extras, set });
        send({ type: "report", report });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "Research failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
