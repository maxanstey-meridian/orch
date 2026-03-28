import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { loadOrchrConfig } from "../../src/config/orchrc.js";
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
});
