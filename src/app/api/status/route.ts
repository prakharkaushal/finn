import type { NextRequest } from "next/server";
import { config, llmEnabled } from "@/lib/config";
import { healthOf } from "@/lib/data/health";
import { runProbe, type ProbeReport } from "@/lib/data/probe";
import { allProviders, DATA_COOKIE, modeFor, providerSet, runMode } from "@/lib/data/service";
import { loadArchive } from "@/lib/inbox/archive";
import { listSnapshotReports } from "@/lib/research/snapshot";

export const maxDuration = 60;

const PROBE_REUSE_MS = 2 * 60_000;
const memo = globalThis as { __finnProbe?: { at: number; report: Promise<ProbeReport> } };

/** At most one live probe every two minutes, whoever asks: the probe makes about a dozen real requests. */
function probeOnce(): Promise<ProbeReport> {
  const hit = memo.__finnProbe;
  if (hit && Date.now() - hit.at < PROBE_REUSE_MS) return hit.report;
  const report = runProbe();
  memo.__finnProbe = { at: Date.now(), report };
  report.catch(() => {
    memo.__finnProbe = undefined;
  });
  return report;
}

/**
 * What this deployment can do, where its data comes from, and how each provider is doing.
 * ?probe=1 also runs a small live sample per provider (see src/lib/data/probe.ts).
 */
export async function GET(request: NextRequest) {
  const wantProbe = request.nextUrl.searchParams.get("probe") === "1";
  const set = providerSet(modeFor(request.cookies.get(DATA_COOKIE)?.value));
  const [archive, reports, manifest, probe] = await Promise.all([
    loadArchive(),
    listSnapshotReports(),
    set.seed.manifest(),
    wantProbe ? probeOnce() : Promise.resolve(null),
  ]);
  return Response.json(
    {
      dataMode: set.mode,
      /** True when the server runs FINN_DATA_MODE=demo: visitors cannot switch to live data. */
      demoForced: runMode() === "demo",
      demo: set.mode === "demo" ? { capturedAt: manifest?.capturedAt ?? null } : null,
      providers: healthOf(allProviders(set)),
      probe,
      llm: { enabled: llmEnabled(), fastModel: config.llm.fastModel, reasoningModel: config.llm.reasoningModel },
      archive: archive ? { updatedAt: archive.updatedAt, items: archive.items.length, pulls: archive.pulls.length } : null,
      precomputedResearch: reports,
      userAgent: config.userAgent,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
