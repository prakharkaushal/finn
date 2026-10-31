import path from "node:path";

/** Runtime configuration. Everything has a safe default so the app runs with no env at all. */
export const config = {
  userAgent:
    process.env.FINN_USER_AGENT ??
    "FINN-prototype/0.1 (investor research demo; low-volume, cached requests)",
  cacheDir:
    process.env.FINN_CACHE_DIR ??
    (process.env.VERCEL ? "/tmp/finn-cache" : path.join(process.cwd(), ".cache")),
  snapshotDir: path.join(process.cwd(), "data", "snapshot"),
  llm: {
    fastModel: process.env.FINN_MODEL_FAST ?? "claude-haiku-5-5",
    reasoningModel: process.env.FINN_MODEL_REASONING ?? "claude-opus-5-5",
  },
} as const;

/** The LLM is optional. It is on only when credentials exist and it has not been switched off. */
export function llmEnabled(): boolean {
  if ((process.env.FINN_LLM ?? "on").toLowerCase() === "off") return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
