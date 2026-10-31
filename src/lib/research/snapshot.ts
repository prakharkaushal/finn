import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import type { ResearchReport } from "@/lib/research/types";

/** Precomputed research reports committed under data/snapshot/research (instant demo, fallback). */

const DIR = (root: string) => path.join(root, "research");

export async function readSnapshotReport(symbol: string, root: string = config.snapshotDir): Promise<ResearchReport | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR(root), `${symbol}.json`), "utf8")) as ResearchReport;
  } catch {
    return null;
  }
}

export async function listSnapshotReports(root: string = config.snapshotDir): Promise<{ symbol: string; generatedAt: string }[]> {
  try {
    const files = (await fs.readdir(DIR(root))).filter((f) => f.endsWith(".json"));
    const out = await Promise.all(
      files.map(async (f) => {
        const r = JSON.parse(await fs.readFile(path.join(DIR(root), f), "utf8")) as ResearchReport;
        return { symbol: r.symbol, generatedAt: r.generatedAt };
      }),
    );
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  } catch {
    return [];
  }
}

export async function writeSnapshotReport(report: ResearchReport, root: string = config.snapshotDir): Promise<void> {
  await fs.mkdir(DIR(root), { recursive: true });
  await fs.writeFile(path.join(DIR(root), `${report.symbol}.json`), JSON.stringify(report, null, 1));
}
