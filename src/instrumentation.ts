/**
 * Runs once when a FINN server starts, before it serves a request: validate the environment
 * and say which mode it runs in. An invalid variable stops the server with the reason.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkEnv } = await import("@/lib/env");
  const { lines, warnings } = checkEnv();
  for (const line of lines) console.log(`[FINN] ${line}`);
  for (const w of warnings) console.warn(`[FINN] warning: ${w}`);
}
