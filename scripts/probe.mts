/**
 * Checks every data provider from this machine with a small live sample and prints what works:
 *   npm run probe                       live sources (bypasses caches)
 *   FINN_DATA_MODE=demo npm run probe   the committed demo dataset
 * Exits non-zero if any check fails. About a dozen polite requests.
 */
import { runProbe } from "@/lib/data/probe";

const report = await runProbe();
const width = Math.max(...report.rows.map((r) => `${r.provider} · ${r.sample}`.length));
console.log(`FINN data probe · ${report.mode} mode · ${report.startedAt}\n`);
for (const r of report.rows) {
  const name = `${r.provider} · ${r.sample}`.padEnd(width);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${name}  ${String(r.ms).padStart(5)} ms  ${r.detail}`);
}
const failed = report.rows.filter((r) => !r.ok).length;
console.log(`\n${report.rows.length - failed} of ${report.rows.length} checks passed`);
process.exit(failed ? 1 : 0);
