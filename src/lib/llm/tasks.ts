import { createHash } from "node:crypto";
import { z } from "zod";
import { cached } from "@/lib/net/cache";
import { structuredFast, structuredReasoning, type LlmCall } from "@/lib/llm/client";
import type { Claim, GuidanceMetric, GuidanceStatement, ThesisPoint } from "@/lib/research/types";

/**
 * The only two places FINN asks a model for anything, each with deterministic checks on
 * what comes back. Outputs are cached by a hash of their exact input.
 */

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/** Numbers as written in text ("15", "15.5", "1,200") — used to check model output against sources. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")).map((n) => String(Number(n)));
}

// ---------------------------------------------------------------- guidance structuring (fast tier)

const METRICS = ["revenue_target", "revenue_growth", "ebitda_growth", "pat_growth", "ebitda_margin", "ebit_margin", "volume_growth", "capex", "other"] as const;

const GuidanceSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      is_guidance: z.boolean(),
      metric: z.enum(METRICS),
      low: z.number().nullable(),
      high: z.number().nullable(),
      unit: z.enum(["%", "INR_cr"]),
      period_text: z.string().nullable(),
    }),
  ),
});

const GUIDANCE_SYSTEM = `You structure management guidance from Indian listed-company earnings-call sentences.
Use only the words of each sentence. Do not use any outside knowledge of the company.
For each sentence decide whether it states a forward-looking, quantified target for the company.
If it does not (past results, analyst views, vague optimism), set is_guidance=false.
low and high must be numbers written in the sentence itself; a single target uses the same number for both; an open-ended target ("at least 20%") sets high to null.
Use unit "INR_cr" only for rupee amounts converted to crore (e.g. an absolute revenue_target or capex); otherwise "%".
period_text must be the exact words from the sentence that name the period (e.g. "FY27", "second half", "next year"), or null.`;

export type StructuredGuidance = { id: string; metric: GuidanceMetric; low?: number; high?: number; unit: "%" | "INR_cr"; periodText: string | null };

export async function structureGuidance(
  items: { id: string; quote: string }[],
): Promise<{ results: StructuredGuidance[]; dropped: number; calls: LlmCall[] }> {
  if (!items.length) return { results: [], dropped: 0, calls: [] };
  const input = items.map((i) => ({ id: i.id, sentence: i.quote }));
  const res = await cached(hash(input), { namespace: "llm-guidance-v1", ttlMs: Infinity }, async () => {
    const out = await structuredFast(GuidanceSchema, GUIDANCE_SYSTEM, JSON.stringify(input));
    return { items: out.data.items, call: out.call };
  });
  const byId = new Map(items.map((i) => [i.id, i.quote]));
  let dropped = 0;
  const results: StructuredGuidance[] = [];
  for (const it of res.value.items) {
    const quote = byId.get(it.id);
    if (!quote || !it.is_guidance) continue;
    const nums = new Set(numbersIn(quote));
    const claimed = [it.low, it.high].filter((v): v is number => v != null);
    const grounded = it.unit === "INR_cr" ? claimed.length > 0 : claimed.every((v) => nums.has(String(v)));
    const periodOk = it.period_text == null || quote.toLowerCase().includes(it.period_text.toLowerCase());
    if (!claimed.length || !grounded || !periodOk) {
      dropped++;
      continue;
    }
    results.push({ id: it.id, metric: it.metric, low: it.low ?? undefined, high: it.high ?? undefined, unit: it.unit, periodText: it.period_text });
  }
  return { results, dropped, calls: res.provenance === "live" ? [res.value.call] : [] };
}

// ---------------------------------------------------------------- bull / bear (reasoning tier)

const PointSchema = z.object({ text: z.string(), claim_ids: z.array(z.string()), statement_ids: z.array(z.string()) });
const ThesisSchema = z.object({ bull: z.array(PointSchema), bear: z.array(PointSchema), divergences: z.array(PointSchema) });

const THESIS_SYSTEM = `You are a buy-side analyst writing a tight bull and bear case for an Indian listed company.
You may use ONLY the facts in the input: numbered claims computed from reported financials, and verbatim management statements (with how each later played out).
Do not add any fact, number, event or context that is not in the input, and do not rely on your own knowledge of the company or its industry.
Every point must cite the ids it rests on. Any number you write must appear in a cited fact.
"divergences" are places where management's narrative and the reported numbers disagree (or notably agree).
Write at most 3 points per list, one sentence each, plain and specific. Return empty lists rather than guess.`;

export async function buildThesis(input: {
  company: string;
  claims: Claim[];
  statements: GuidanceStatement[];
}): Promise<{ bull: ThesisPoint[]; bear: ThesisPoint[]; divergences: ThesisPoint[]; dropped: number; calls: LlmCall[] }> {
  const facts = {
    company: input.company,
    claims: input.claims.map((c) => ({ id: c.id, text: c.text })),
    statements: input.statements.map((s) => ({
      id: s.id,
      call: s.callLabel,
      quote: s.quote,
      outcome: s.verdict ? `${s.verdict.status}${s.verdict.actualLabel ? `: ${s.verdict.actualLabel} ${s.verdict.actual?.toFixed(1)}` : ""}` : "not assessed",
    })),
  };
  const res = await cached(hash(facts), { namespace: "llm-thesis-v1", ttlMs: Infinity }, async () => {
    const out = await structuredReasoning(ThesisSchema, THESIS_SYSTEM, JSON.stringify(facts));
    return { thesis: out.data, call: out.call };
  });

  const claimText = new Map(facts.claims.map((c) => [c.id, c.text]));
  const stmtText = new Map(facts.statements.map((s) => [s.id, `${s.quote} ${s.outcome}`]));
  let dropped = 0;
  const keep = (points: z.infer<typeof PointSchema>[]): ThesisPoint[] =>
    points.slice(0, 3).flatMap((p) => {
      const claimIds = p.claim_ids.filter((id) => claimText.has(id));
      const statementIds = p.statement_ids.filter((id) => stmtText.has(id));
      const cited = [...claimIds.map((id) => claimText.get(id)!), ...statementIds.map((id) => stmtText.get(id)!)].join(" ");
      const citedNums = new Set(numbersIn(cited));
      const ok = cited.length > 0 && numbersIn(p.text).every((n) => citedNums.has(n));
      if (!ok) {
        dropped++;
        return [];
      }
      return [{ text: p.text, claimIds, statementIds }];
    });

  const t = res.value.thesis;
  return {
    bull: keep(t.bull),
    bear: keep(t.bear),
    divergences: keep(t.divergences),
    dropped,
    calls: res.provenance === "live" ? [res.value.call] : [],
  };
}
