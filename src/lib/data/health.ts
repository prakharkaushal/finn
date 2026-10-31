import { errorMessage, isNoData, type ProviderMeta } from "@/lib/data/providers";
import type { ExtractionIssue, ProviderHealth } from "@/lib/data/schema";

/**
 * Per-provider call outcomes for the status view. Kept on globalThis because route handlers
 * may be bundled separately but share one server process. On serverless hosts each instance
 * keeps its own counters; the live probe (/api/status?probe=1) checks sources directly.
 */

type Counter = {
  calls: number;
  failures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  lastLatencyMs?: number;
  /** Set when the last success was a fallback (stale copy) or too thin to use. */
  degraded?: string;
  issues: ExtractionIssue[];
};

const store: Map<string, Counter> = ((globalThis as { __finnProviderHealth?: Map<string, Counter> }).__finnProviderHealth ??= new Map());

function counter(id: string): Counter {
  let c = store.get(id);
  if (!c) {
    c = { calls: 0, failures: 0, issues: [] };
    store.set(id, c);
  }
  return c;
}

/** degraded: why a successful answer should still be flagged; issues: logged, not status-changing. */
export type Assessment = { degraded?: string; issues?: ExtractionIssue[] };

export async function track<T>(meta: ProviderMeta, run: () => Promise<T>, assess?: (value: T) => Assessment): Promise<T> {
  const c = counter(meta.id);
  c.calls++;
  const started = performance.now();
  try {
    const value = await run();
    const a = assess?.(value) ?? {};
    c.lastSuccessAt = new Date().toISOString();
    c.lastLatencyMs = Math.round(performance.now() - started);
    c.degraded = a.degraded;
    if (a.issues?.length) c.issues = [...a.issues, ...c.issues].slice(0, 8);
    return value;
  } catch (err) {
    c.lastLatencyMs = Math.round(performance.now() - started);
    if (isNoData(err)) {
      // The provider answered; it just holds nothing for this input.
      c.lastSuccessAt = new Date().toISOString();
      c.degraded = undefined;
    } else {
      c.failures++;
      c.lastFailureAt = new Date().toISOString();
      c.lastError = errorMessage(err);
    }
    throw err;
  }
}

export function healthOf(providers: ProviderMeta[]): ProviderHealth[] {
  return providers.map((p) => {
    const c = store.get(p.id);
    let status: ProviderHealth["status"] = "idle";
    if (c?.calls) {
      const failedLast = c.lastFailureAt != null && (c.lastSuccessAt == null || c.lastFailureAt > c.lastSuccessAt);
      status = failedLast ? "down" : c.degraded ? "degraded" : "ok";
    }
    return {
      id: p.id,
      label: p.label,
      kind: p.kind,
      status,
      calls: c?.calls ?? 0,
      failures: c?.failures ?? 0,
      ...(c?.lastSuccessAt ? { lastSuccessAt: c.lastSuccessAt } : {}),
      ...(c?.lastFailureAt ? { lastFailureAt: c.lastFailureAt } : {}),
      ...(c?.lastError ? { lastError: c.lastError } : {}),
      ...(c?.lastLatencyMs != null ? { lastLatencyMs: c.lastLatencyMs } : {}),
      ...(status === "degraded" && c?.degraded ? { degradedBecause: c.degraded } : {}),
      issues: c?.issues ?? [],
      ...(p.note ? { note: p.note } : {}),
    };
  });
}

/** Tests only. */
export function resetHealth() {
  store.clear();
}
