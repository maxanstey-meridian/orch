import { describe, it, expect } from "vitest";
import { withBrief, buildTddPrompt, buildReviewPreamble, buildReviewPrompt, buildGapPrompt, buildFinalPasses } from "../src/prompts.js";

describe("withBrief", () => {
  it("returns prompt unchanged when brief is empty", () => {
    expect(withBrief("hello", "")).toBe("hello");
  });

  it("prepends wrapped brief content when brief is non-empty", () => {
    const result = withBrief("hello", "context");
    expect(result).toContain("context");
    expect(result).toContain("hello");
  });
});

describe("buildTddPrompt", () => {
  it("includes slice content and TDD keywords", () => {
    const result = buildTddPrompt("slice text");
    expect(result).toContain("slice text");
    expect(result).toContain("RED");
    expect(result).toContain("GREEN");
  });

  it("includes fix instructions in fix mode", () => {
    const result = buildTddPrompt("slice", "fix this");
    expect(result).toContain("fix this");
    expect(result).toContain("Review Feedback");
  });
});

describe("buildReviewPreamble", () => {
  it("includes base SHA and review discipline keywords", () => {
    const result = buildReviewPreamble("abc123");
    expect(result).toContain("abc123");
    expect(result).toContain("Review discipline");
    expect(result).toContain("Two-pass priority");
  });
});

describe("buildReviewPrompt", () => {
  it("includes slice content and REVIEW_CLEAN sentinel", () => {
    const result = buildReviewPrompt("slice", "abc123");
    expect(result).toContain("slice");
    expect(result).toContain("REVIEW_CLEAN");
  });
});

describe("buildGapPrompt", () => {
  it("includes group content and NO_GAPS_FOUND sentinel", () => {
    const result = buildGapPrompt("group content", "abc123");
    expect(result).toContain("group content");
    expect(result).toContain("NO_GAPS_FOUND");
  });
});

describe("buildFinalPasses", () => {
  it("returns array of 3 passes with name and prompt", () => {
    const passes = buildFinalPasses("abc123", "plan");
    expect(passes).toHaveLength(3);
    for (const pass of passes) {
      expect(pass).toHaveProperty("name");
      expect(pass).toHaveProperty("prompt");
    }
  });

  it("has the expected pass names", () => {
    const passes = buildFinalPasses("abc123", "plan");
    const names = passes.map((p) => p.name);
    expect(names).toContain("Type fidelity");
    expect(names).toContain("Plan completeness");
    expect(names).toContain("Cross-cutting integration");
  });
});
