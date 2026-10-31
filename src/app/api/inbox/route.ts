import type { NextRequest } from "next/server";
import { DATA_COOKIE, modeFor, providerSet } from "@/lib/data/service";
import { getInbox } from "@/lib/inbox/service";
import { parseInboxQuery } from "@/lib/inbox/params";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const query = parseInboxQuery(request.nextUrl.searchParams);
  if (query.symbols.length === 0) {
    return Response.json({ error: "Add at least one NSE symbol to your portfolio." }, { status: 400 });
  }
  try {
    const inbox = await getInbox(query, { set: providerSet(modeFor(request.cookies.get(DATA_COOKIE)?.value)) });
    return Response.json(inbox, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: `Could not assemble the inbox: ${message}` }, { status: 502 });
  }
}
