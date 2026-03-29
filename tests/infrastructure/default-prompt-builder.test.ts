import { describe, it, expect } from "vitest";
import { DefaultPromptBuilder } from "../../src/infrastructure/default-prompt-builder.js";
import { PromptBuilder } from "../../src/application/ports/prompt-builder.port.js";
import { withBrief, buildPlanPrompt, buildTddPrompt, buildReviewPrompt, buildCompletenessPrompt, buildCommitSweepPrompt, buildGapPrompt, buildFinalPasses } from "../../src/plan/prompts.js";
import { TDD_RULES_REMINDER, REVIEW_RULES_REMINDER, buildRulesReminder } from "../../src/agent/agent-factory.js";

const BRIEF = "This is a test brief";
const PLAN_CONTENT = "Full plan content here";

describe("DefaultPromptBuilder", () => {
  it("can be instantiated and is an instance of PromptBuilder", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder).toBeInstanceOf(PromptBuilder);

    const withRules = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT, "tdd rules", "review rules");
    expect(withRules).toBeInstanceOf(PromptBuilder);
  });

  it("withBrief injects stored brief without requiring it as parameter", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.withBrief("hello")).toBe(withBrief("hello", BRIEF));
  });

  it("withBrief returns prompt unchanged when brief is empty", () => {
    const builder = new DefaultPromptBuilder("", PLAN_CONTENT);
    expect(builder.withBrief("hello")).toBe("hello");
  });

  it("plan wraps buildPlanPrompt output with brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const expected = withBrief(buildPlanPrompt("slice content", PLAN_CONTENT, 3), BRIEF);
    expect(builder.plan("slice content", 3)).toBe(expected);
  });

  it("tdd delegates to buildTddPrompt with stored planContent", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.tdd("slice", undefined, 5)).toBe(
      buildTddPrompt("slice", undefined, PLAN_CONTENT, 5),
    );
    expect(builder.tdd("slice", "fix this", 5)).toBe(
      buildTddPrompt("slice", "fix this", PLAN_CONTENT, 5),
    );
  });

  describe("tddExecute", () => {
    it("firstSlice=true, no guidance: includes plan context and brief", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      const result = builder.tddExecute("the plan", 3, true);
      expect(result).toContain("## Full Plan Context");
      expect(result).toContain(PLAN_CONTENT);
      expect(result).toContain("Execute this plan for Slice 3:");
      expect(result).toContain("the plan");
      // Brief is injected on first slice
      expect(result).toBe(
        withBrief(
          `## Full Plan Context\nYou are implementing Slice 3. Here is the full plan — do NOT implement other slices.\n\n${PLAN_CONTENT}\n\n---\n\nExecute this plan for Slice 3:\n\nthe plan`,
          BRIEF,
        ),
      );
    });

    it("firstSlice=true, with guidance: includes operator guidance", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      const result = builder.tddExecute("the plan", 3, true, "focus on edge cases");
      expect(result).toContain("Operator guidance: focus on edge cases");
      expect(result).toContain("## Full Plan Context");
      expect(result).toContain("Execute this plan for Slice 3:");
    });

    it("firstSlice=false, no guidance: no plan context, no brief", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      const result = builder.tddExecute("the plan", 5, false);
      expect(result).not.toContain("## Full Plan Context");
      expect(result).not.toContain(PLAN_CONTENT);
      expect(result).toBe("Execute this plan for Slice 5:\n\nthe plan");
    });
  });

  it("review delegates to buildReviewPrompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.review("content", "sha", "prior")).toBe(
      buildReviewPrompt("content", "sha", "prior"),
    );
    expect(builder.review("content", "sha")).toBe(
      buildReviewPrompt("content", "sha"),
    );
  });

  it("completeness delegates with stored planContent", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.completeness("slice", "sha", 3)).toBe(
      buildCompletenessPrompt("slice", "sha", PLAN_CONTENT, 3),
    );
  });

  it("gap delegates to buildGapPrompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.gap("group", "sha")).toBe(buildGapPrompt("group", "sha"));
  });

  it("commitSweep delegates to buildCommitSweepPrompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.commitSweep("Auth")).toBe(buildCommitSweepPrompt("Auth"));
  });

  it("finalPasses delegates with stored planContent", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.finalPasses("sha")).toEqual(buildFinalPasses("sha", PLAN_CONTENT));
  });

  describe("rulesReminder", () => {
    it("tdd includes TDD_RULES_REMINDER and custom tddRules", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT, "extra tdd", "extra review");
      expect(builder.rulesReminder("tdd")).toBe(
        buildRulesReminder(TDD_RULES_REMINDER, "extra tdd"),
      );
    });

    it("review includes REVIEW_RULES_REMINDER and custom reviewRules", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT, "extra tdd", "extra review");
      expect(builder.rulesReminder("review")).toBe(
        buildRulesReminder(REVIEW_RULES_REMINDER, "extra review"),
      );
    });

    it("without custom rules returns bare reminder", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      expect(builder.rulesReminder("tdd")).toBe(TDD_RULES_REMINDER);
      expect(builder.rulesReminder("review")).toBe(REVIEW_RULES_REMINDER);
    });
  });
});
