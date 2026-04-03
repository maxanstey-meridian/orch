import { describe, it, expect } from "vitest";
import { DefaultPromptBuilder } from "#infrastructure/default-prompt-builder.js";
import { PromptBuilder } from "#application/ports/prompt-builder.port.js";
import { withBrief, buildPlanPrompt, buildTddPrompt, buildDirectExecutePrompt, buildDirectTestPassPrompt, buildVerifyPrompt, buildReviewPrompt, buildCompletenessPrompt, buildCommitSweepPrompt, buildGapPrompt, buildFinalPasses } from "#infrastructure/plan/prompts.js";
import { TDD_RULES_REMINDER, REVIEW_RULES_REMINDER, buildRulesReminder } from "#infrastructure/claude/claude-agent-factory.js";

const BRIEF = "This is a test brief";
const PLAN_CONTENT = "Full plan content here";
const SLICE_WITH_CRITERIA = `### Slice 2: Criteria-aware prompts

**Why:** Prompt contracts need binary acceptance checks.

**Files:** \`src/infrastructure/plan/prompts.ts\` (edit)

**Criteria:**
- TDD prompt requires at least one regression guard per criterion
- Completeness prompt reports PASS/FAIL/DIVERGENT per criterion

Implement criteria-aware prompt wording.

**Tests:** Cover criteria-aware and legacy fallback wording.`;

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

  it("keeps criteria-aware fix-mode tdd prompts aligned with the stored plan context", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const prompt = builder.tdd(SLICE_WITH_CRITERIA, "fix unmet criterion coverage", 2);

    expect(prompt).toBe(
      buildTddPrompt(SLICE_WITH_CRITERIA, "fix unmet criterion coverage", PLAN_CONTENT, 2),
    );
    expect(prompt).toContain(PLAN_CONTENT);
    expect(prompt).toContain("For each criterion in the `**Criteria:**` section");
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

    it("firstSlice=false, with guidance: includes guidance, no plan context, no brief", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      const result = builder.tddExecute("the plan", 5, false, "check types");
      expect(result).toContain("Operator guidance: check types");
      expect(result).toContain("Execute this plan for Slice 5:");
      expect(result).toContain("the plan");
      expect(result).not.toContain("## Full Plan Context");
      expect(result).not.toContain(PLAN_CONTENT);
      // No brief wrapping on non-first slice
      expect(result).not.toContain(BRIEF);
    });

    it("firstSlice=false, no guidance: no plan context, no brief", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      const result = builder.tddExecute("the plan", 5, false);
      expect(result).not.toContain("## Full Plan Context");
      expect(result).not.toContain(PLAN_CONTENT);
      expect(result).toBe("Execute this plan for Slice 5:\n\nthe plan");
    });
  });

  describe("groupedExecute", () => {
    it("firstGroup=true includes full-plan context and brief", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      const result = builder.groupedExecute("Core", "group plan", true);
      expect(result).toContain("## Full Plan Context");
      expect(result).toContain(PLAN_CONTENT);
      expect(result).toContain("Execute this plan for Group Core as one bounded increment:");
      expect(result).toContain("group plan");
      expect(result).toContain(BRIEF);
    });

    it("firstGroup=false omits full-plan context and brief", () => {
      const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
      const result = builder.groupedExecute("Core", "group plan", false, "focus on integration");
      expect(result).toContain("Operator guidance: focus on integration");
      expect(result).toContain("Execute this plan for Group Core as one bounded increment:");
      expect(result).not.toContain("## Full Plan Context");
      expect(result).not.toContain(BRIEF);
    });
  });

  it("groupedTestPass builds a mandatory group test-pass prompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const result = builder.groupedTestPass("Core", "group plan");
    expect(result).toContain("mandatory test pass for Group Core");
    expect(result).toContain("changed behavior");
    expect(result).toContain("group plan");
  });

  it("directExecute wraps the direct execute prompt with the stored brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.directExecute("request text")).toBe(
      withBrief(buildDirectExecutePrompt("request text"), BRIEF),
    );
  });

  it("directTestPass wraps the direct test-pass prompt with the stored brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.directTestPass("request text")).toBe(
      withBrief(buildDirectTestPassPrompt("request text"), BRIEF),
    );
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

  it("verify wraps buildVerifyPrompt output with brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.verify("sha", 3)).toBe(
      withBrief(buildVerifyPrompt("sha", "Slice 3"), BRIEF),
    );
    expect(builder.verify("sha", 3, "fixed summary")).toBe(
      withBrief(buildVerifyPrompt("sha", "Slice 3", "fixed summary"), BRIEF),
    );
  });

  it("groupedVerify wraps buildVerifyPrompt output with brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.groupedVerify("sha", "Core")).toBe(
      withBrief(buildVerifyPrompt("sha", "Group Core"), BRIEF),
    );
  });

  it("completeness delegates with stored planContent", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.completeness("slice", "sha", 3)).toBe(
      buildCompletenessPrompt("slice", "sha", PLAN_CONTENT, 3),
    );
  });

  it("keeps stored full-plan context when delegating criteria-aware tdd and completeness prompts", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const tddPrompt = builder.tdd(SLICE_WITH_CRITERIA, undefined, 2);
    const completenessPrompt = builder.completeness(SLICE_WITH_CRITERIA, "sha", 2);

    expect(tddPrompt).toContain(PLAN_CONTENT);
    expect(tddPrompt).toContain("For each criterion in the `**Criteria:**` section");
    expect(completenessPrompt).toContain(PLAN_CONTENT);
    expect(completenessPrompt).toContain("Report PASS, FAIL, or DIVERGENT for each criterion");
  });

  it("groupedCompleteness builds a grouped completeness prompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const result = builder.groupedCompleteness("group plan", "sha", "Core");
    expect(result).toContain("implemented Group Core as one bounded increment");
    expect(result).toContain("GROUP_COMPLETE");
    expect(result).toContain("group plan");
    expect(result).toContain(PLAN_CONTENT);
  });

  it("gap delegates to buildGapPrompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    expect(builder.gap("group", "sha")).toBe(buildGapPrompt("group", "sha"));
  });

  it("keeps review and gap output backward-compatible when criteria are absent", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const legacyReview = builder.review("legacy content", "sha");
    const legacyGap = builder.gap("legacy group content", "sha");

    expect(legacyReview).not.toContain("## Criteria check");
    expect(legacyReview).toContain("for context, not as acceptance criteria");
    expect(legacyGap).not.toContain("Prioritise missing regression guards tied to explicit criteria");
    expect(legacyGap).toContain("NO_GAPS_FOUND");
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
