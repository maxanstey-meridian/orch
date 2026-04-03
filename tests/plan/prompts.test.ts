import { describe, it, expect } from "vitest";
import {
  withBrief,
  buildTddPrompt,
  buildReviewPreamble,
  buildReviewPrompt,
  buildGapPrompt,
  buildFinalPasses,
  buildCommitSweepPrompt,
  buildPlanPrompt,
  buildPlanGenerationPrompt,
} from "#infrastructure/plan/prompts.js";

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
    expect(result).toContain("Fix Discipline");
    expect(result).toContain("implementation obligation");
    expect(result).toContain("expected-failing test");
    expect(result).toContain("If the reviewer/gap pass tells you to implement a non-egregious fix, do it");
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

describe("buildPlanPrompt", () => {
  it("produces expected prompt with slice content and planning instructions", () => {
    const result = buildPlanPrompt("slice content here");
    expect(result).toContain("You are a planning agent");
    expect(result).toContain("slice content here");
    expect(result).toContain("Do NOT write any code");
  });

  it("makes plan authority and inference policy explicit", () => {
    const result = buildPlanPrompt("slice content here");
    expect(result).toContain("the plan is the authority");
    expect(result).toContain("Future-slice wiring stays deferred");
    expect(result).toContain("Compatibility/fallback behavior must be stated, not invented");
  });
});

describe("buildPlanGenerationPrompt", () => {
  it("teaches grouped mode to produce coarse increments with explicit mode metadata", () => {
    const result = buildPlanGenerationPrompt("grouped");
    expect(result).toContain('"executionMode": "grouped"');
    expect(result).toContain("coarse groups with independently meaningful deliverables");
    expect(result).toContain("review/verify cadence is driven by group boundaries");
    expect(result).toContain("larger internal change sets");
    expect(result).toContain("Reject micro-slice churn");
  });
});

describe("buildCommitSweepPrompt", () => {
  it("includes the group name and key instruction text", () => {
    const prompt = buildCommitSweepPrompt("Authentication");
    expect(prompt).toContain("Authentication");
    expect(prompt).toContain("uncommitted changes");
    expect(prompt).toContain("commit");
  });

  it("handles empty group name without crashing", () => {
    const prompt = buildCommitSweepPrompt("");
    expect(prompt).toContain("uncommitted changes");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("handles group name with special characters", () => {
    const prompt = buildCommitSweepPrompt('Auth "OAuth2" & <SSO>');
    expect(prompt).toContain('Auth "OAuth2" & <SSO>');
    expect(prompt).toContain("uncommitted changes");
  });
});
