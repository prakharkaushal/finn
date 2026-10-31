import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_CATEGORIES } from "@/lib/domain/categories";
import { appendPull, covered, gapsWithin, mergeIntervals, nseCoverage, type ArchivedAnnouncement } from "@/lib/inbox/archive";
import { buildFilingItems, shortRole } from "@/lib/inbox/build";
import { parseInboxQuery } from "@/lib/inbox/params";
import { buildIndex, parseMasterCsv } from "@/lib/sources/nse-master";
import { parseNseRss } from "@/lib/sources/nse-rss";
import { interpretXbrl } from "@/lib/sources/xbrl";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const index = buildIndex(parseMasterCsv(fixture("nse-equity-sample.csv")));
const feed = parseNseRss(fixture("nse-rss-sample.xml"), index);
const now = Date.parse("2026-10-27T23:00:00+05:30");
const names = new Map([["HOMEFIRST", "Home First Finance Company India"], ["SYNGENE", "Syngene International"]]);

function withXbrl(items: ArchivedAnnouncement[]): ArchivedAnnouncement[] {
  const cfo = interpretXbrl(fixture("xbrl-homefirst-cfo-appointment.xml"));
  const smp = interpretXbrl(fixture("xbrl-syngene-cessations.xml"));
  return items.map((a) => {
    if (a.docType !== "xbrl" || !/Change in Directors/i.test(a.subject)) return a;
    if (a.symbol === "HOMEFIRST") return { ...a, xbrl: cfo };
    if (a.symbol === "SYNGENE") return { ...a, xbrl: smp };
    return a;
  });
}

describe("inbox assembly", () => {
  const { items, upcoming } = buildFilingItems({
    announcements: withXbrl(feed.items),
    names,
    alertCategories: new Set(DEFAULT_ALERT_CATEGORIES),
    windowFrom: now - 24 * 3_600_000,
    now,
  });
  const forSymbol = (s: string) => items.filter((i) => i.symbol === s);

  it("bundles a results day into one card with the other filings attached", () => {
    const results = forSymbol("HOMEFIRST").filter((i) => i.category === "results");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ headline: "Q2 FY27 results", tier: "attention", results: { periodEnd: "2026-09-30" } });
    expect(results[0].related.length).toBeGreaterThan(0);
    expect(results[0].primary.docType).toBe("pdf");
  });

  it("leads the management card with the disclosed profile of the incoming CFO", () => {
    const card = forSymbol("HOMEFIRST").find((i) => i.category === "management_change")!;
    expect(card.headline).toBe("CFO appointed: Ms. Rinkoo Somani");
    expect(card.tier).toBe("attention");
    expect(card.xbrl?.details.kind).toBe("management");
    if (card.xbrl?.details.kind === "management") expect(card.xbrl.details.people[0].briefProfile).toMatch(/HDFC/);
  });

  it("keeps senior-management exits below key-role changes", () => {
    const card = forSymbol("SYNGENE").find((i) => i.category === "management_change")!;
    expect(card.tier).toBe("look");
    expect(card.headline).toMatch(/resigns: Mr\. Ajay Tandon/);
  });

  it("sorts attention first and buries routine filings", () => {
    const tiers = items.map((i) => i.tier);
    const firstRoutine = tiers.indexOf("routine");
    expect(tiers.slice(0, Math.max(0, firstRoutine)).every((t) => t !== "routine")).toBe(true);
    expect(items.filter((i) => i.tier === "routine").every((i) => !i.triggered)).toBe(true);
  });

  it("lists announced results dates that are still ahead", () => {
    expect(upcoming.some((u) => u.date === "2026-10-30")).toBe(true);
    expect(upcoming.every((u) => u.date >= "2026-10-27")).toBe(true);
  });

  it("respects the time window", () => {
    const tight = buildFilingItems({ announcements: feed.items, names, alertCategories: new Set(), windowFrom: now - 3_600_000, now });
    expect(tight.items.length).toBeLessThan(items.length);
    expect(tight.items.every((i) => Date.parse(i.ts) >= now - 3_600_000)).toBe(true);
  });

  it("abbreviates titles for headlines", () => {
    expect(shortRole("Managing Director & Chief Executive Officer")).toBe("MD & CEO");
    expect(shortRole("Non - Executive Independent Director")).toBe("Independent director");
  });
});

describe("archive coverage", () => {
  const h = 3_600_000;

  it("merges overlapping intervals and reports the gaps", () => {
    const merged = mergeIntervals([{ from: 0, to: 5 * h }, { from: 4 * h, to: 8 * h }, { from: 20 * h, to: 24 * h }]);
    expect(merged).toEqual([{ from: 0, to: 8 * h }, { from: 20 * h, to: 24 * h }]);
    expect(gapsWithin(0, 24 * h, merged)).toEqual([{ from: 8 * h, to: 20 * h }]);
    expect(covered(6 * h, merged)).toBe(true);
    expect(covered(10 * h, merged)).toBe(false);
  });

  it("only counts archive pulls that tracked the symbol", () => {
    const archive = appendPull(null, { fetchedAt: new Date(10 * h).toISOString(), from: new Date(2 * h).toISOString(), items: [] }, ["HOMEFIRST"]);
    expect(nseCoverage("HOMEFIRST", archive, null)).toHaveLength(1);
    expect(nseCoverage("SYNGENE", archive, null)).toHaveLength(0);
  });

  it("keeps only tracked symbols when appending and dedupes by document", () => {
    const first = appendPull(null, { fetchedAt: "2026-10-27T17:00:00Z", from: "2026-10-26T18:00:00Z", items: feed.items }, ["HOMEFIRST"]);
    const again = appendPull(first, { fetchedAt: "2026-10-27T18:00:00Z", from: "2026-10-26T19:00:00Z", items: feed.items }, ["HOMEFIRST"]);
    expect(first.items.every((i) => i.symbol === "HOMEFIRST")).toBe(true);
    expect(again.items).toHaveLength(first.items.length);
    expect(again.pulls).toHaveLength(2);
    expect(again.items.every((i) => i.via === "archive")).toBe(true);
  });

  it("records a cached feed served twice as a single pull", () => {
    const pull = { fetchedAt: "2026-10-27T17:00:00Z", from: "2026-10-26T18:00:00Z", items: feed.items };
    const twice = appendPull(appendPull(null, pull, ["HOMEFIRST"]), pull, ["HOMEFIRST"]);
    expect(twice.pulls).toHaveLength(1);
  });

  it("keeps the newest pull time when an older saved feed is imported later", () => {
    const newer = appendPull(null, { fetchedAt: "2026-10-28T03:00:00Z", from: "2026-10-27T18:30:00Z", items: [] }, ["HOMEFIRST"]);
    const withOlder = appendPull(newer, { fetchedAt: "2026-10-27T17:00:00Z", from: "2026-10-26T18:00:00Z", items: [] }, ["HOMEFIRST"]);
    expect(withOlder.updatedAt).toBe("2026-10-28T03:00:00Z");
  });
});

describe("inbox query parsing", () => {
  it("validates symbols, clamps thresholds and defaults alert categories", () => {
    const q = parseInboxQuery(new URLSearchParams("symbols=reliance.ns,TCS,,bad;sym,TCS&window=7d&price=999&volume=abc"));
    expect(q.symbols).toEqual(["RELIANCE", "TCS"]);
    expect(q.windowKey).toBe("7d");
    expect(q.thresholds.pricePct).toBe(50);
    expect(q.thresholds.volumeMultiple).toBe(2);
    expect(q.alertCategories).toEqual(DEFAULT_ALERT_CATEGORIES);
    expect(parseInboxQuery(new URLSearchParams("symbols=TCS&alerts=")).alertCategories).toEqual([]);
    expect(parseInboxQuery(new URLSearchParams("symbols=TCS&window=1y")).windowKey).toBe("24h");
  });
});
