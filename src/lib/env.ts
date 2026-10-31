import { z } from "zod";

/**
 * FINN's environment, validated once at server start (src/instrumentation.ts). Nothing is
 * required: with no variables at all FINN runs in live mode with the deterministic engine. But
 * a variable that is set must be valid — a typo such as FINN_DATA_MODE=dmeo would otherwise
 * silently mean "live", and a malformed key would fail later, mid-request.
 */

// An empty value (as copied from .env.example) means "not set".
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const EnvSchema = z.object({
  FINN_DATA_MODE: optional(z.enum(["live", "demo"], { message: 'must be "live" or "demo"' })),
  FINN_PRICE_PROVIDER: optional(z.enum(["yahoo", "nse-bhavcopy"], { message: 'must be "yahoo" or "nse-bhavcopy"' })),
  FINN_LLM: optional(z.enum(["on", "off"], { message: 'must be "on" or "off"' })),
  ANTHROPIC_API_KEY: optional(z.string().regex(/^\S{20,}$/, "must be a single token of at least 20 characters, with no spaces")),
  ANTHROPIC_AUTH_TOKEN: optional(z.string().regex(/^\S{20,}$/, "must be a single token of at least 20 characters, with no spaces")),
  FINN_MODEL_FAST: optional(z.string().regex(/^claude-[a-z0-9.-]+$/, "must be a Claude model id such as claude-haiku-5-5")),
  FINN_MODEL_REASONING: optional(z.string().regex(/^claude-[a-z0-9.-]+$/, "must be a Claude model id such as claude-opus-5-5")),
  FINN_USER_AGENT: optional(z.string().min(8, "is too short to identify FINN").max(200, "is longer than 200 characters").regex(/^[^\r\n]+$/, "must be one line")),
  FINN_CACHE_DIR: optional(z.string()),
});

export type FinnEnv = z.infer<typeof EnvSchema>;

export type EnvSummary = {
  env: FinnEnv;
  /** Plain statements for the startup log. */
  lines: string[];
  /** Valid but worth fixing (e.g. a production deploy with the default User-Agent). */
  warnings: string[];
};

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`FINN environment is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}\nSee .env.example for every variable and its allowed values.`);
    this.name = "EnvError";
  }
}

export function checkEnv(source: Record<string, string | undefined> = process.env): EnvSummary {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) throw new EnvError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`));
  const env = parsed.data;
  const key = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const llm = env.FINN_LLM === "off" ? "off (FINN_LLM=off)" : key ? `on (${env.FINN_MODEL_FAST ?? "claude-haiku-5-5"} / ${env.FINN_MODEL_REASONING ?? "claude-opus-5-5"})` : "off (no ANTHROPIC_API_KEY)";
  const lines = [
    env.FINN_DATA_MODE === "demo" ? "data: demo for every visitor (FINN_DATA_MODE=demo; nothing is fetched)" : "data: live, falling back to the committed snapshot (visitors can switch to demo data)",
    `prices: ${env.FINN_PRICE_PROVIDER === "nse-bhavcopy" ? "NSE bhavcopy first, then Yahoo" : "Yahoo first, then NSE bhavcopy"}`,
    `LLM: ${llm}`,
  ];
  const warnings: string[] = [];
  if (source.NODE_ENV === "production" && !env.FINN_USER_AGENT && env.FINN_DATA_MODE !== "demo") {
    warnings.push("FINN_USER_AGENT is not set: set it to name this deployment with a contact URL, so sources can tell who is fetching.");
  }
  return { env, lines, warnings };
}
