import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_CATEGORIES } from "@/lib/domain/categories";
import { DEFAULT_THRESHOLDS, type MarketSignal } from "@/lib/domain/signals";
import { buildFilingItems } from "@/lib/inbox/build";
import { filingWhy, marketHeadline, marketWhy } from "@/lib/inbox/why";
import { buildIndex, parseMasterCsv } from "@/lib/sources/nse-master";
import { parseNseRss } from "@/lib/sources/nse-rss";
import { interpretXbrl } from "@/lib/sources/xbrl";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("why it matters", () => {
  it("states the incoming person's role and start date from the filing", () => {
    const xbrl = interpretXbrl(fixture("xbrl-homefirst-cfo-appointment.xml"));
    expect(filingWhy({ subtype: "mgmt_key", xbrl })).toBe("New CFO from 27 Oct. The company's own profile of the appointee is below.");
  });

  it("says when a resignation letter gives no detailed reason", () => {
    const xbrl = interpretXbrl(fixture("xbrl-syngene-cessations.xml"));
    expect(filingWhy({ subtype: "mgmt_other", xbrl })).toBe("Head Strategy & Corporate Development leaving from 30 Oct. The resignation letter gives no detailed reason.");
  });

  it("uses the disclosed order value when there is one, and says where it is when not", () => {
    const withValue = interpretXbrl(fixture("xbrl-arisinfra-order.xml"));
    expect(filingWhy({ subtype: "order_win", xbrl: withValue })).toBe("₹9.85 cr of new orders adds to revenue visibility.");
    expect(filingWhy({ subtype: "order_win" })).toBe("New orders add to revenue visibility; the value is in the filing.");
  });

  it("quantifies dilution for an equity raise", () => {
    const xbrl = { kind: "capital" as const, capital: { issuanceType: "Preferential Issue", dilutionPct: 4.25 } };
    expect(filingWhy({ subtype: "equity_raise", xbrl: { details: xbrl } })).toBe("New shares raise the share count by 4.25%, diluting existing holders.");
  });

  it("flags related-party deals", () => {
    const xbrl = interpretXbrl(fixture("xbrl-sgmart-acquisition.xml"));
    expect(filingWhy({ subtype: "ma_new", xbrl })).toMatch(/related-party deal/i);
  });

  it("gives routine paperwork no 'why' at all", () => {
    expect(filingWhy({ subtype: "routine" })).toBeNull();
    expect(filingWhy({ subtype: "esop" })).toBeNull();
  });

  it("describes market alerts in terms of the investor's own rules", () => {
    const s: MarketSignal = {
      date: "2026-10-27",
      close: 95,
      prevClose: 101,
      changePct: -5.94,
      volume: 3000,
      avgVolume: 1000,
      volumeRatio: 3,
      spark: [],
      hits: [
        { id: "price", label: "" },
        { id: "volume", label: "" },
      ],
      excludedPartialSession: false,
    };
    expect(marketHeadline(s)).toBe("Fell 5.9% · volume 3.0× average");
    expect(marketWhy(s, DEFAULT_THRESHOLDS)).toBe("In the session of 27 Oct it moved more than your ±4% rule and traded above your 2× 20-day volume rule.");
  });
});

describe("inbox items carry why and provenance", () => {
  const index = buildIndex(parseMasterCsv(fixture("nse-equity-sample.csv")));
  const feed = parseNseRss(fixture("nse-rss-sample.xml"), index);
  const now = Date.parse("2026-10-27T23:00:00+05:30");
  const { items } = buildFilingItems({
    announcements: feed.items,
    names: new Map(),
    alertCategories: new Set(DEFAULT_ALERT_CATEGORIES),
    windowFrom: now - 24 * 3_600_000,
    now,
    sourceOf: () => ({ provenance: "cache", asOf: "2026-10-27T17:20:00.000Z" }),
  });

  it("labels every item with where it came from and when", () => {
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.provenance === "cache" && i.asOf === "2026-10-27T17:20:00.000Z")).toBe(true);
  });

  it("explains material items and stays quiet on routine ones", () => {
    expect(items.filter((i) => i.tier === "attention").every((i) => i.why)).toBe(true);
    expect(items.filter((i) => i.tier === "routine").every((i) => i.why === null)).toBe(true);
  });
});
