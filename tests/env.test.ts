import { afterEach, describe, expect, it } from "vitest";
import { checkEnv, EnvError } from "@/lib/env";
import { modeFor } from "@/lib/data/service";

describe("environment validation at startup", () => {
  it("runs with no variables at all, in live mode with the LLM off", () => {
    const { lines, warnings } = checkEnv({});
    expect(lines.join(" | ")).toMatch(/data: live.*visitors can switch to demo/);
    expect(lines.join(" | ")).toMatch(/LLM: off \(no ANTHROPIC_API_KEY\)/);
    expect(warnings).toEqual([]);
  });

  it("treats empty values copied from .env.example as not set", () => {
    expect(() => checkEnv({ ANTHROPIC_API_KEY: "", FINN_DATA_MODE: " ", FINN_MODEL_FAST: "" })).not.toThrow();
  });

  it("stops on a typo instead of silently falling back, naming every bad variable", () => {
    const run = () => checkEnv({ FINN_DATA_MODE: "dmeo", FINN_LLM: "yes", FINN_MODEL_FAST: "gpt-4o", ANTHROPIC_API_KEY: "sk ant with spaces" });
    expect(run).toThrow(EnvError);
    try {
      run();
    } catch (err) {
      const problems = (err as EnvError).problems.join("\n");
      for (const name of ["FINN_DATA_MODE", "FINN_LLM", "FINN_MODEL_FAST", "ANTHROPIC_API_KEY"]) expect(problems).toContain(name);
    }
  });

  it("says which mode and models it runs with, and warns a production deploy without a User-Agent", () => {
    const demo = checkEnv({ FINN_DATA_MODE: "demo", NODE_ENV: "production" });
    expect(demo.lines[0]).toMatch(/demo for every visitor/);
    expect(demo.warnings).toEqual([]);
    const live = checkEnv({ NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-ant-api03-0123456789abcdef", FINN_PRICE_PROVIDER: "nse-bhavcopy" });
    expect(live.lines).toEqual(expect.arrayContaining([expect.stringMatching(/NSE bhavcopy first/), expect.stringMatching(/LLM: on \(claude-haiku-5-5 \/ claude-opus-5-5\)/)]));
    expect(live.warnings.join(" ")).toMatch(/FINN_USER_AGENT/);
  });
});

describe("demo and live data per visit", () => {
  const saved = process.env.FINN_DATA_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.FINN_DATA_MODE;
    else process.env.FINN_DATA_MODE = saved;
  });

  it("lets a visitor opt into demo data on a live deployment", () => {
    delete process.env.FINN_DATA_MODE;
    expect(modeFor(undefined)).toBe("live");
    expect(modeFor("live")).toBe("live");
    expect(modeFor("demo")).toBe("demo");
    expect(modeFor("anything else")).toBe("live");
  });

  it("serves demo data to everyone when the deployment forces it", () => {
    process.env.FINN_DATA_MODE = "demo";
    expect(modeFor(undefined)).toBe("demo");
    expect(modeFor("live")).toBe("demo");
  });
});
