import type { CompanyFundamentals } from "@/lib/data/schema";
import { fyLabel, quarterDiscussedOnCall } from "@/lib/domain/periods";
import { isPublicHttpsUrl } from "@/lib/net/http";
import type { DocRef } from "@/lib/research/ingest";

/**
 * Which primary documents a report reads. screener.in's company page is only the discovery
 * entry point (it lists the company's annual reports, call transcripts and presentations); the
 * documents themselves are the evidence. FINN reads the latest annual report, the last four
 * call transcripts, the latest presentation and the latest results filing on NSE, plus up to
 * three documents the investor adds. Older annual reports are listed, not read.
 */

export const MAX_TRANSCRIPTS = 4;
export const MAX_EXTRAS = 3;

export type ExtraSource = { url: string; kind: "annual_report" | "transcript" | "presentation" | "other"; period?: string };

const EXTRA_KINDS = new Set(["annual_report", "transcript", "presentation", "other"]);

/** Validates investor-added sources: public https URLs only, a known kind, a sensible period. */
export function parseExtras(raw: string | null): { extras: ExtraSource[]; errors: string[] } {
  if (!raw) return { extras: [], errors: [] };
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return { extras: [], errors: ["Added sources could not be read"] };
  }
  if (!Array.isArray(list)) return { extras: [], errors: ["Added sources could not be read"] };
  const extras: ExtraSource[] = [];
  const errors: string[] = [];
  for (const item of list.slice(0, MAX_EXTRAS)) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    const kind = typeof item?.kind === "string" && EXTRA_KINDS.has(item.kind) ? (item.kind as ExtraSource["kind"]) : null;
    const period = typeof item?.period === "string" ? item.period.trim() : undefined;
    if (!isPublicHttpsUrl(url)) {
      errors.push(`Skipped ${url || "an empty link"}: only public https links can be read`);
      continue;
    }
    if (!kind) {
      errors.push(`Skipped ${url}: unknown document type`);
      continue;
    }
    if (kind === "annual_report" && period && !/^20\d{2}$/.test(period)) {
      errors.push(`Skipped ${url}: an annual report's year looks like 2026`);
      continue;
    }
    if (kind === "transcript" && period && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)) {
      errors.push(`Skipped ${url}: a call's month looks like 2026-08`);
      continue;
    }
    extras.push({ url, kind, ...(period ? { period } : {}) });
  }
  return { extras, errors };
}

export type Discovery = { selected: DocRef[]; listed: DocRef[] };

const monthLabel = (month: string) => new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

export function discoverDocuments(f: Pick<CompanyFundamentals, "documents">, results: DocRef | null, extras: ExtraSource[] = []): Discovery {
  const byDate = <T extends { date?: string }>(a: T, b: T) => (b.date ?? "").localeCompare(a.date ?? "");
  const reports: DocRef[] = f.documents
    .filter((d) => d.kind === "annual_report" && /^\d{4}$/.test(d.date ?? ""))
    .sort(byDate)
    .map((d) => ({ id: d.id, kind: "annual_report", title: d.title, url: d.url, fy: Number(d.date), period: fyLabel(Number(d.date)), date: d.date }));
  const calls: DocRef[] = f.documents
    .filter((d) => d.kind === "transcript" && /^\d{4}-\d{2}$/.test(d.date ?? ""))
    .sort(byDate)
    .map((d) => ({ id: `call-${d.date}`, kind: "transcript", title: d.title, url: d.url, period: d.period, date: d.date }));
  const decks: DocRef[] = f.documents
    .filter((d) => d.kind === "presentation" && /^\d{4}-\d{2}$/.test(d.date ?? ""))
    .sort(byDate)
    .map((d) => ({ id: `ppt-${d.date}`, kind: "presentation", title: d.title, url: d.url, period: d.period, date: d.date }));

  const added: DocRef[] = extras.map((e, i) => {
    const base = { id: `user-${i + 1}`, url: e.url, userAdded: true };
    if (e.kind === "annual_report") {
      const fy = e.period ? Number(e.period) : undefined;
      return { ...base, kind: "annual_report", title: `Annual report${fy ? ` ${fy}` : ""} (added by you)`, ...(fy ? { fy, period: fyLabel(fy), date: e.period } : {}) };
    }
    if (e.kind === "transcript" && e.period) {
      return { ...base, id: `call-${e.period}-user`, kind: "transcript", title: `Earnings-call transcript, ${monthLabel(e.period)} (added by you)`, date: e.period, period: quarterDiscussedOnCall(e.period)?.label };
    }
    if (e.kind === "presentation") return { ...base, kind: "presentation", title: "Investor presentation (added by you)" };
    return { ...base, kind: "user", title: "Document added by you" };
  });

  const selected = [...reports.slice(0, 1), ...calls.slice(0, MAX_TRANSCRIPTS), ...decks.slice(0, 1), ...(results ? [results] : []), ...added];
  const seen = new Set<string>();
  const unique = selected.filter((d) => !seen.has(d.url) && seen.add(d.url));
  return { selected: unique, listed: reports.slice(1, 3).filter((d) => !seen.has(d.url)) };
}
