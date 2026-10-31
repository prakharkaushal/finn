import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK client is mocked: these tests check FINN's own guardrails on model output, offline.
vi.mock("@/lib/llm/client", () => ({
  structuredFast: vi.fn(),
  structuredReasoning: vi.fn(),
}));

import { structuredFast, structuredReasoning } from "@/lib/llm/client";
import { buildThesis, numbersIn, structureGuidance } from "@/lib/llm/tasks";
import type { Claim, GuidanceStatement } from "@/lib/research/types";

const call = { model: "mock", inputTokens: 10, outputTokens: 10 };

beforeEach(() => {
  rmSync(process.env.FINN_CACHE_DIR!, { recursive: true, force: true });
  vi.mocked(structuredFast).mockReset();
  vi.mocked(structuredReasoning).mockReset();
});

describe("numbers in text", () => {
  it("normalises grouping and decimals", () => {
    expect(numbersIn("₹1,200 crore, 15.5% and 20")).toEqual(["1200", "15.5", "20"]);
  });
});

describe("guidance structuring guardrails", () => {
  const items = [
    { id: "a", quote: "We are looking at a corridor of 20% to 24% for FY27." },
    { id: "b", quote: "Growth should be healthy going forward." },
    { id: "c", quote: "We expect 12% growth next year." },
  ];

  it("keeps only items whose numbers and period words appear in the sentence", async () => {
    vi.mocked(structuredFast).mockResolvedValue({
      data: {
        items: [
          { id: "a", is_guidance: true, metric: "ebitda_margin", low: 20, high: 24, unit: "%", period_text: "FY27" },
          { id: "b", is_guidance: true, metric: "revenue_growth", low: 15, high: 15, unit: "%", period_text: null }, // 15 is invented
          { id: "c", is_guidance: true, metric: "revenue_growth", low: 12, high: 12, unit: "%", period_text: "FY28" }, // period not in quote
          { id: "zz", is_guidance: true, metric: "revenue_growth", low: 12, high: 12, unit: "%", period_text: null }, // unknown id
        ],
      },
      call,
    });
    const out = await structureGuidance(items);
    expect(out.results).toEqual([{ id: "a", metric: "ebitda_margin", low: 20, high: 24, unit: "%", periodText: "FY27" }]);
    expect(out.dropped).toBe(2);
    expect(out.calls).toHaveLength(1);
  });

  it("serves an identical request from cache without calling the model again", async () => {
    const fresh = [{ id: "d", quote: "We expect capex of Rs 500 crores in FY28." }];
    vi.mocked(structuredFast).mockResolvedValue({ data: { items: [] }, call });
    await structureGuidance(fresh);
    const second = await structureGuidance(fresh);
    expect(structuredFast).toHaveBeenCalledTimes(1);
    expect(second.calls).toHaveLength(0);
  });

  it("does not call the model when nothing needs structuring", async () => {
    await structureGuidance([]);
    expect(structuredFast).not.toHaveBeenCalled();
  });
});

describe("bull/bear guardrails", () => {
  const claims: Claim[] = [
    { id: "traj-revenue-cagr", text: "Revenue compounded at 14.9% a year over FY21–FY26.", tone: "positive", citations: [] },
    { id: "bs-de", text: "Debt-to-equity was 0.04 at FY26 end.", tone: "positive", citations: [] },
  ];
  const statements: GuidanceStatement[] = [
    {
      id: "call-2026-02-1",
      sourceId: "call-2026-02",
      callLabel: "Feb 2026 call",
      callMonth: "2026-02",
      page: 10,
      quote: "The EBITDA corridor which we have shared is 20% to 24%.",
      metric: "ebitda_margin",
      low: 20,
      high: 24,
      structuredBy: "rules",
      verdict: { status: "delivered", actual: 24.1, actualLabel: "FY26 EBITDA margin", basis: "" },
    },
  ];

  it("drops points that cite nothing real or quote numbers absent from what they cite", async () => {
    vi.mocked(structuredReasoning).mockResolvedValue({
      data: {
        bull: [
          { text: "Revenue compounded at 14.9% a year.", claim_ids: ["traj-revenue-cagr"], statement_ids: [] },
          { text: "Margins landed at 24.1%, inside the 20–24% corridor.", claim_ids: [], statement_ids: ["call-2026-02-1"] },
        ],
        bear: [
          { text: "Market share fell to 31%.", claim_ids: ["bs-de"], statement_ids: [] }, // 31 not in cited fact
          { text: "Competition is intensifying.", claim_ids: ["made-up-id"], statement_ids: [] }, // cites nothing real
        ],
        divergences: [],
      },
      call,
    });
    const t = await buildThesis({ company: "Test", claims, statements });
    expect(t.bull).toHaveLength(2);
    expect(t.bear).toHaveLength(0);
    expect(t.dropped).toBe(2);
  });
});
