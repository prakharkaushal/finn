import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config, llmEnabled } from "@/lib/config";

/**
 * Thin wrapper over the Anthropic SDK with two tiers: a cheap model for bulk structuring
 * and a strong model for synthesis. Callers get typed, schema-validated objects or an
 * error they can show; the app never depends on these calls to function.
 */

export class LlmUnavailableError extends Error {}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!llmEnabled()) throw new LlmUnavailableError("No LLM configured (set ANTHROPIC_API_KEY to enable)");
  client ??= new Anthropic({ maxRetries: 2, timeout: 50_000 });
  return client;
}

/** Models that accept server-side refusal fallbacks (fallbacks: "default"). */
const FALLBACK_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"];

export type LlmCall = { model: string; inputTokens: number; outputTokens: number };

export async function structuredFast<S extends z.ZodType>(schema: S, system: string, user: string): Promise<{ data: z.infer<S>; call: LlmCall }> {
  const res = await getClient().messages.parse({
    model: config.llm.fastModel,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(schema), effort: "low" },
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined this request");
  if (res.parsed_output == null) throw new Error(`No structured output (stop reason: ${res.stop_reason})`);
  return { data: res.parsed_output, call: { model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
}

export async function structuredReasoning<S extends z.ZodType>(schema: S, system: string, user: string): Promise<{ data: z.infer<S>; call: LlmCall }> {
  const model = config.llm.reasoningModel;
  const withFallback = FALLBACK_MODELS.includes(model);
  const res = await getClient().beta.messages.parse({
    model,
    max_tokens: 16000,
    ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: betaZodOutputFormat(schema), effort: "medium" },
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined this request");
  if (res.parsed_output == null) throw new Error(`No structured output (stop reason: ${res.stop_reason})`);
  return { data: res.parsed_output, call: { model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
}

/** Human-readable reason for an LLM failure, using the SDK's typed errors. */
export function describeLlmError(err: unknown): string {
  if (err instanceof LlmUnavailableError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "LLM key rejected";
  if (err instanceof Anthropic.RateLimitError) return "LLM rate-limited; try again shortly";
  if (err instanceof Anthropic.APIError) return `LLM error ${err.status ?? ""}`.trim();
  return err instanceof Error ? err.message : "LLM call failed";
}
