/**
 * Refreshes the committed capture in data/snapshot/ — the demo dataset (FINN_DATA_MODE=demo)
 * and the live mode's last-resort fallback:
 *   - manifest.json          when this capture was taken and what it covers
 *   - nse-equity-list.csv    NSE's equity master list
 *   - filings-archive.json   NSE filings for tracked symbols: today's RSS feed (with Reg-30 XBRL
 *                            parsed in), 30 days per symbol from NSE's announcements API, and
 *                            BSE recents via screener.in — so 3d/7d/30d windows have history
 *   - market.json            end-of-day series (canonical PriceSeries, with adjusted closes)
 *   - fundamentals.json      screener.in statements and document links, parsed
 *   - research/<SYMBOL>.json precomputed research reports for the demo picks
 *
 * Usage: npm run snapshot [-- --skip-research] [-- SYMBOL SYMBOL ...]
 *        npm run snapshot -- --research-only [SYMBOL ...]   (rebuild reports, keep the captured dataset)
 *        npm run snapshot -- --import-rss=path/to/Online_announcements.xml   (archive a saved feed file)
 * Every request is cached and rate-limited per host; a full run makes ~100 polite requests.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { FUNDAMENTALS_FILE, MANIFEST_FILE, MARKET_FILE, type SeedManifest } from "@/lib/data/adapters/seed";
import { indexFor, nseApiAnnouncements } from "@/lib/data/adapters/nse";
import type { PriceSeries } from "@/lib/data/schema";
import { getPrices, providerSet } from "@/lib/data/service";
import { istDate } from "@/lib/domain/signals";
import { appendPull, ARCHIVE_FILE, loadArchive, type ArchivedAnnouncement } from "@/lib/inbox/archive";
import { fetchText } from "@/lib/net/http";
import { DEFAULT_PORTFOLIO, RESEARCH_PICKS } from "@/lib/portfolio";
import { buildReport } from "@/lib/research/pipeline";
import { writeSnapshotReport } from "@/lib/research/snapshot";
import { loadMaster, MASTER_SNAPSHOT_FILE, NSE_MASTER_URL } from "@/lib/sources/nse-master";
import { loadNseFeed, parseNseRss } from "@/lib/sources/nse-rss";
import { loadScreenerCompany, type ScreenerCompany } from "@/lib/sources/screener";
import { loadXbrl } from "@/lib/sources/xbrl";

const args = process.argv.slice(2);
const skipResearch = args.includes("--skip-research");
const researchOnly = args.includes("--research-only");
const importRss = args.find((a) => a.startsWith("--import-rss="))?.slice("--import-rss=".length);
const researchSymbols = args.filter((a) => !a.startsWith("--"));
const portfolio = DEFAULT_PORTFOLIO.map((p) => p.symbol);
const tracked = [...new Set([...portfolio, ...RESEARCH_PICKS])];
const XBRL_WORTH_READING =
  /change in director|change in management|resignation|appointment|cessation|acquisition|restructuring|amalgamation|merger|bagging|order|fund raising|alteration of capital|actions initiated|orders passed|insolvency/i;
const DAY = 86_400_000;

const log = (msg: string) => console.log(`[snapshot] ${msg}`);

async function writeJson(name: string, value: unknown) {
  await fs.mkdir(config.snapshotDir, { recursive: true });
  await fs.writeFile(path.join(config.snapshotDir, name), JSON.stringify(value, null, 1));
}

async function withXbrl(items: ArchivedAnnouncement[]) {
  for (const a of items) {
    if (a.docType !== "xbrl" || !XBRL_WORTH_READING.test(a.subject)) continue;
    try {
      a.xbrl = (await loadXbrl(a.url)).value;
    } catch (err) {
      log(`  xbrl failed ${a.url}: ${(err as Error).message}`);
    }
  }
}

/** Archives a previously saved copy of the NSE feed; its own lastBuildDate is the pull time. */
async function importSavedFeed(file: string) {
  const xml = await fs.readFile(file, "utf8");
  const built = xml.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/)?.[1];
  const fetchedAt = built ? new Date(built).toISOString() : null;
  if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) throw new Error("Saved feed has no usable lastBuildDate");
  const pull = parseNseRss(xml, indexFor((await loadMaster()).value));
  if (!pull.coverage) throw new Error("Saved feed has no items");
  const items: ArchivedAnnouncement[] = pull.items.filter((i) => i.symbol && tracked.includes(i.symbol)).map((i) => ({ ...i }));
  await withXbrl(items);
  await writeJson(ARCHIVE_FILE, appendPull(await loadArchive(), { fetchedAt, from: pull.coverage.from, items }, tracked));
  log(`imported saved feed: ${items.length} tracked filings, covering ${pull.coverage.from} → ${fetchedAt}`);
}

/** Rebuilds the precomputed reports from live sources; the reports carry their own timestamps. */
async function snapshotResearch() {
  for (const symbol of researchSymbols.length ? researchSymbols : RESEARCH_PICKS) {
    const t0 = Date.now();
    try {
      const report = await buildReport({ exchange: "NSE", code: symbol }, (e) => {
        if (e.type === "step" && e.status !== "running") log(`  ${symbol} · ${e.id}: ${e.status}${e.detail ? ` (${e.detail})` : ""}`);
      });
      await writeSnapshotReport({ ...report, provenance: "snapshot" });
      log(`research: ${symbol} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      log(`  research failed ${symbol}: ${(err as Error).message}`);
    }
  }
}

async function main() {
  if (importRss) return importSavedFeed(importRss);
  if (providerSet().mode === "demo") throw new Error("Unset FINN_DATA_MODE=demo: the snapshot is captured from live sources");
  if (researchOnly) return snapshotResearch();
  const capturedAt = new Date().toISOString();

  // 1. Master list
  const csv = await fetchText(NSE_MASTER_URL, { source: "NSE equity list" });
  await fs.mkdir(config.snapshotDir, { recursive: true });
  await fs.writeFile(path.join(config.snapshotDir, MASTER_SNAPSHOT_FILE), csv);
  const master = await loadMaster();
  const index = indexFor(master.value);
  const directory = { companies: master.value, index, source: { provider: "nse-master", type: "exchange" as const, url: NSE_MASTER_URL, retrievedAt: master.fetchedAt, mode: master.provenance } };
  log(`master list: ${master.value.length} symbols`);

  // 2. Filings archive: today's NSE feed (+ XBRL), 30 days per symbol from NSE's API, BSE recents
  let archive = await loadArchive();
  const feed = await loadNseFeed(index);
  if (feed.value.coverage) {
    const fresh: ArchivedAnnouncement[] = feed.value.items.filter((i) => i.symbol && tracked.includes(i.symbol)).map((i) => ({ ...i }));
    await withXbrl(fresh);
    archive = appendPull(archive, { fetchedAt: feed.fetchedAt, from: feed.value.coverage.from, items: fresh }, tracked);
    log(`feed: ${fresh.length} tracked filings (covers ${feed.value.coverage.from} → ${feed.fetchedAt})`);
  } else {
    log("feed: empty right now (it restarts at midnight)");
  }
  try {
    const to = Date.now();
    const batch = await nseApiAnnouncements.recent({ symbols: tracked, from: to - 30 * DAY, to, directory });
    const covered = Object.keys(batch.coverage);
    const from = Math.min(...covered.map((s) => batch.coverage[s][0].from));
    // The archive stores raw listings; the seed adapter re-attaches a source when it reads them.
    const items: ArchivedAnnouncement[] = batch.items.map((a) => {
      const copy: ArchivedAnnouncement & { source?: unknown } = { ...a };
      delete copy.source;
      return copy;
    });
    archive = appendPull(archive, { fetchedAt: batch.source.retrievedAt, from: new Date(from).toISOString(), items }, covered);
    log(`NSE API: ${items.length} filings over 30 days for ${covered.length}/${tracked.length} symbols${batch.issues.length ? ` (${batch.issues.length} issues)` : ""}`);
    for (const issue of batch.issues.slice(0, 5)) log(`  ${issue.subject}: ${issue.message}`);
  } catch (err) {
    log(`  NSE API failed: ${(err as Error).message}`);
  }

  // 3. Fundamentals (also the source of BSE recents)
  const companies: Record<string, ScreenerCompany> = {};
  const bse: ArchivedAnnouncement[] = [];
  for (const symbol of tracked) {
    try {
      const company = (await loadScreenerCompany(symbol)).value;
      companies[symbol] = company;
      for (const d of company.announcements) {
        if (!d.date) continue;
        bse.push({ id: d.url, symbol, companyName: company.name, subject: d.title, description: d.title, url: d.url, docType: "pdf", ts: d.date, exchange: "BSE", via: "screener" });
      }
    } catch (err) {
      log(`  screener failed ${symbol}: ${(err as Error).message}`);
    }
  }
  await writeJson(FUNDAMENTALS_FILE, { capturedAt, companies });
  log(`fundamentals: ${Object.keys(companies).length}/${tracked.length} companies`);

  if (archive) {
    // BSE items carry no coverage claim of their own; the inbox uses them only outside NSE coverage.
    const byId = new Map(archive.items.map((i) => [i.id, i]));
    for (const b of bse) if (!byId.has(b.id)) byId.set(b.id, b);
    archive = { ...archive, items: [...byId.values()].sort((x, y) => y.ts.localeCompare(x.ts)) };
    await writeJson(ARCHIVE_FILE, archive);
    log(`archive: ${archive.items.length} filings, ${archive.pulls.length} pulls`);
  }

  // 4. End-of-day series (through the live provider chain, so the stored source says which one
  //    answered). Only completed sessions are kept: a capture taken during market hours would
  //    otherwise freeze a half-day's bar that demo mode treats as a finished session.
  const series: Record<string, PriceSeries> = {};
  const today = istDate(Date.now());
  for (const symbol of tracked) {
    try {
      const s = await getPrices({ exchange: "NSE", code: symbol });
      const partial = s.sessionOpen && s.bars.at(-1)?.date === today;
      series[symbol] = partial
        ? { ...s, bars: s.bars.slice(0, -1), sessionOpen: false, issues: [...s.issues, { provider: s.source.provider, subject: `${symbol} ${today}`, message: "Session still trading at capture; partial bar left out" }] }
        : s;
    } catch (err) {
      log(`  prices failed ${symbol}: ${(err as Error).message}`);
    }
  }
  await writeJson(MARKET_FILE, { asOf: capturedAt, series });
  log(`market: ${Object.keys(series).length}/${tracked.length} series`);

  // 5. Precomputed research
  if (!skipResearch) await snapshotResearch();

  const manifest: SeedManifest = { capturedAt, portfolio, researchPicks: RESEARCH_PICKS };
  await writeJson(MANIFEST_FILE, manifest);
  log(`done — captured at ${capturedAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
