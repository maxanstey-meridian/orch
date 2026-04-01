import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { loadOrchrConfig, resolveOrchrConfig, loadAndResolveOrchrConfig, resolveSkillValue, buildOrchrSummary } from "#infrastructure/config/orchrc.js";
import { readFileSync } from "node:fs";

describe("loadOrchrConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns defaults when .orchrc.json does not exist", () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT");
    err.code = "ENOENT";
    vi.mocked(readFileSync).mockImplementation(() => { throw err; });

    const result = loadOrchrConfig("/fake");
    expect(result).toEqual({});
  });

  it("parses minimal config", () => {
    vi.mocked(readFileSync).mockReturnValue("{}");

    const result = loadOrchrConfig("/fake");
    expect(result).toEqual({});
  });

  it("accepts null skill values", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ skills: { tdd: null } }));

    const result = loadOrchrConfig("/fake");
    expect(result.skills?.tdd).toBeNull();
  });

  it("accepts string skill values", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ skills: { review: "./custom.md" } }));

    const result = loadOrchrConfig("/fake");
    expect(result.skills?.review).toBe("./custom.md");
  });

  it("accepts string rules", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ rules: { tdd: "./rules.md" } }));

    const result = loadOrchrConfig("/fake");
    expect(result.rules?.tdd).toBe("./rules.md");
  });

  it("accepts array rules", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ rules: { review: ["a.md", "b.md"] } }));

    const result = loadOrchrConfig("/fake");
    expect(result.rules?.review).toEqual(["a.md", "b.md"]);
  });

  it("parses valid full config", () => {
    const full = {
      skills: { tdd: "./tdd.md", review: null, verify: "./v.md", plan: null, gap: "./g.md" },
      rules: { tdd: "./rules.md", review: ["a.md", "b.md"] },
      config: { maxReviewCycles: 3, reviewThreshold: 80, maxReplans: 2 },
    };
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(full));

    const result = loadOrchrConfig("/fake");
    expect(result).toEqual(full);
  });

  it("accepts reviewThreshold of zero", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ config: { reviewThreshold: 0 } }));

    const result = loadOrchrConfig("/fake");
    expect(result.config?.reviewThreshold).toBe(0);
  });

  it("rejects invalid config values", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ config: { maxReviewCycles: -1 } }));

    expect(() => loadOrchrConfig("/fake")).toThrow("maxReviewCycles");
  });

  it("rejects unknown top-level keys", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ foo: "bar" }));

    expect(() => loadOrchrConfig("/fake")).toThrow("Invalid .orchrc.json");
  });

  it("rejects non-string skill values", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ skills: { tdd: 42 } }));

    expect(() => loadOrchrConfig("/fake")).toThrow("Invalid .orchrc.json");
  });

  it("throws descriptive error on malformed JSON", () => {
    vi.mocked(readFileSync).mockReturnValue("{ not json");

    expect(() => loadOrchrConfig("/fake")).toThrow();
  });

  it("re-throws non-ENOENT errors", () => {
    const err: NodeJS.ErrnoException = new Error("EACCES");
    err.code = "EACCES";
    vi.mocked(readFileSync).mockImplementation(() => { throw err; });

    expect(() => loadOrchrConfig("/fake")).toThrow("EACCES");
  });

  it("rejects non-integer config values", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ config: { maxReviewCycles: 2.5 } }));

    expect(() => loadOrchrConfig("/fake")).toThrow("maxReviewCycles");
  });

  it("rejects zero for maxReplans", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ config: { maxReplans: 0 } }));

    expect(() => loadOrchrConfig("/fake")).toThrow("maxReplans");
  });

  it("accepts valid agents config", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ agents: { tdd: "codex", plan: "claude:opus" } }),
    );

    const result = loadOrchrConfig("/fake");
    expect(result.agents).toEqual({ tdd: "codex", plan: "claude:opus" });
  });

  it("rejects invalid agent config value", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ agents: { tdd: "invalid" } }),
    );

    expect(() => loadOrchrConfig("/fake")).toThrow("Invalid .orchrc.json");
  });

  it("rejects unknown role in agents", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ agents: { unknown: "claude" } }),
    );

    expect(() => loadOrchrConfig("/fake")).toThrow("Invalid .orchrc.json");
  });
});

describe("resolveOrchrConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("marks missing skills as default", () => {
    const result = resolveOrchrConfig({}, "/fake");
    expect(result.skills.tdd).toEqual({ default: true });
    expect(result.skills.review).toEqual({ default: true });
    expect(result.skills.verify).toEqual({ default: true });
    expect(result.skills.plan).toEqual({ default: true });
    expect(result.skills.gap).toEqual({ default: true });
  });

  it("marks null skills as disabled", () => {
    const result = resolveOrchrConfig({ skills: { tdd: null } }, "/fake");
    expect(result.skills.tdd).toEqual({ disabled: true });
    expect(result.skills.review).toEqual({ default: true });
  });

  it("throws on missing skill file", () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT");
    err.code = "ENOENT";
    vi.mocked(readFileSync).mockImplementation(() => { throw err; });

    expect(() => resolveOrchrConfig({ skills: { review: "./missing.md" } }, "/fake"))
      .toThrow("/fake/missing.md");
  });

  it("resolves skill path to file content", () => {
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === "/fake/custom.md") return "custom content";
      throw new Error(`unexpected read: ${p}`);
    });

    const result = resolveOrchrConfig({ skills: { review: "./custom.md" } }, "/fake");
    expect(result.skills.review).toEqual({ content: "custom content" });
  });

  it("resolves single rule file", () => {
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === "/fake/rule.md") return "rule content";
      throw new Error(`unexpected read: ${p}`);
    });

    const result = resolveOrchrConfig({ rules: { tdd: "./rule.md" } }, "/fake");
    expect(result.rules.tdd).toBe("rule content");
  });

  it("concatenates array rule files", () => {
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === "/fake/a.md") return "contentA";
      if (p === "/fake/b.md") return "contentB";
      throw new Error(`unexpected read: ${p}`);
    });

    const result = resolveOrchrConfig({ rules: { review: ["./a.md", "./b.md"] } }, "/fake");
    expect(result.rules.review).toBe("contentA\n\ncontentB");
  });

  it("missing rules are undefined", () => {
    const result = resolveOrchrConfig({}, "/fake");
    expect(result.rules.tdd).toBeUndefined();
    expect(result.rules.review).toBeUndefined();
  });

  it("passes config values through", () => {
    const result = resolveOrchrConfig({ config: { maxReviewCycles: 5, reviewThreshold: 0 } }, "/fake");
    expect(result.config.maxReviewCycles).toBe(5);
    expect(result.config.reviewThreshold).toBe(0);
  });

  it("throws on missing rule file", () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT");
    err.code = "ENOENT";
    vi.mocked(readFileSync).mockImplementation(() => { throw err; });

    expect(() => resolveOrchrConfig({ rules: { tdd: "./missing.md" } }, "/fake"))
      .toThrow("/fake/missing.md");
  });

  it("re-throws non-ENOENT errors when resolving skill file", () => {
    const err: NodeJS.ErrnoException = new Error("EACCES");
    err.code = "EACCES";
    vi.mocked(readFileSync).mockImplementation(() => { throw err; });

    expect(() => resolveOrchrConfig({ skills: { tdd: "./skill.md" } }, "/fake"))
      .toThrow("EACCES");
  });

  it("handles empty rules array", () => {
    const result = resolveOrchrConfig({ rules: { review: [] } }, "/fake");
    expect(result.rules.review).toBe("");
  });

  it("buildOrchrSummary returns undefined when all default", () => {
    const config = resolveOrchrConfig({}, "/fake");
    expect(buildOrchrSummary(config)).toBeUndefined();
  });

  it("buildOrchrSummary labels disabled and custom skills", () => {
    const config = resolveOrchrConfig({}, "/fake");
    config.skills.tdd = { disabled: true };
    config.skills.review = { content: "x" };
    const summary = buildOrchrSummary(config);
    expect(summary).toContain("tdd: disabled");
    expect(summary).toContain("review: custom");
  });

  it("buildOrchrSummary lists config overrides", () => {
    const config = resolveOrchrConfig({}, "/fake");
    config.config = { maxReplans: 1 };
    const summary = buildOrchrSummary(config);
    expect(summary).toBe("maxReplans: 1");
  });

  it("buildOrchrSummary includes reviewThreshold: 0", () => {
    const config = resolveOrchrConfig({}, "/fake");
    config.config = { reviewThreshold: 0 };
    const summary = buildOrchrSummary(config);
    expect(summary).toBe("reviewThreshold: 0");
  });

  it("buildOrchrSummary combines skill and config overrides", () => {
    const config = resolveOrchrConfig({}, "/fake");
    config.skills.review = { content: "x" };
    config.config = { maxReplans: 1 };
    const summary = buildOrchrSummary(config);
    expect(summary).toBe("review: custom, maxReplans: 1");
  });

  it("buildOrchrSummary includes agent overrides", () => {
    const config = resolveOrchrConfig({ agents: { tdd: "codex", plan: "claude:opus" } }, "/fake");
    const summary = buildOrchrSummary(config);
    expect(summary).toContain("tdd: codex");
    expect(summary).toContain("plan: claude:opus");
  });

  it("resolveSkillValue returns built-in for default, null for disabled, custom content for content", () => {
    expect(resolveSkillValue({ default: true }, "built-in")).toBe("built-in");
    expect(resolveSkillValue({ disabled: true }, "built-in")).toBeNull();
    expect(resolveSkillValue({ content: "custom" }, "built-in")).toBe("custom");
  });

  it("loadAndResolveOrchrConfig loads and resolves", () => {
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith(".orchrc.json")) {
        return JSON.stringify({ skills: { tdd: "./tdd.md" } });
      }
      if (p === "/fake/tdd.md") return "tdd content";
      throw new Error(`unexpected read: ${p}`);
    });

    const result = loadAndResolveOrchrConfig("/fake");
    expect(result.skills.tdd).toEqual({ content: "tdd content" });
  });
});
