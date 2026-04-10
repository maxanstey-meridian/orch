import { describe, expect, it } from "vitest";
import { PromptBuilder } from "#application/ports/prompt-builder.port.js";
import {
  buildCommitSweepPrompt,
  buildCompletenessPrompt,
  buildDirectCompletenessPrompt,
  buildDirectExecutePrompt,
  buildDirectFinalPasses,
  buildDirectGapPrompt,
  buildDirectReviewPrompt,
  buildDirectTestPassPrompt,
  buildDirectVerifyPrompt,
  buildFinalPasses,
  buildGapPrompt,
  buildGroupedCompletenessPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildTddPrompt,
  buildVerifyPrompt,
  withBrief,
} from "#infrastructure/plan/prompts.js";
import { DefaultPromptBuilder } from "#infrastructure/prompts/default-prompt-builder.js";

const BRIEF = "This is a test brief";
const PLAN_CONTENT = "Full plan content here";
const EXTRA_TDD_RULES = "extra tdd";
const EXTRA_REVIEW_RULES = "extra review";

const TDD_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. RUN TESTS WITH BASH. Use your Bash tool to execute tests. Read the actual output. Do not narrate "RED confirmed" or "GREEN" without executing. No exceptions.
2. COMMIT WHEN DONE. After all behaviours are GREEN, run the full test suite, then git add + git commit. Uncommitted work is invisible to the review agent.
3. STAY IN SCOPE. Only modify files relevant to your current task. Do not touch, revert, or "clean up" unrelated files. Use git add with specific filenames, never git add . or git add -A.
4. USE CLASSES FOR STATEFUL SERVICES. Do not create standalone functions with deps bags or parameter objects. If something holds state or coordinates multiple operations, make it a class with constructor injection. Methods access dependencies via \`this\`, not via passed-in params objects.
5. WRITE DEFENSIVE TESTS. For every feature, verify: if someone deleted the key line that makes it work, would a test fail? If not, add one. Test observable state changes directly — not mock call arguments. A test that passes whether the feature works or not is worse than no test.`;

const REVIEW_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. ONLY REVIEW THE DIFF. Review files changed in the diff. Ignore unrelated uncommitted changes in the working tree — they belong to the operator.
2. DO NOT SUGGEST REVERTING unrelated files (skill files, config, HUD changes) that weren't part of the slice.
3. If the diff is empty and HEAD hasn't moved, respond with REVIEW_CLEAN. Do not claim work is missing if it was committed in prior commits.`;

const buildRulesReminder = (baseRules: string, extraRules?: string): string =>
  !extraRules
    ? baseRules
    : `${baseRules}\n\n[PROJECT] Additional rules from .orchrc.json:\n${extraRules}`;

const SLICE_WITH_CRITERIA = `### Slice 2: Criteria-aware prompts

**Why:** Prompt contracts need binary acceptance checks.

**Files:** \`src/infrastructure/plan/prompts.ts\` (edit)

**Criteria:**
- TDD prompt requires at least one regression guard per criterion
- Completeness prompt reports PASS/FAIL/DIVERGENT per criterion

Implement criteria-aware prompt wording.

**Tests:** Cover criteria-aware and legacy fallback wording.`;

const GROUP_WITH_CRITERIA = `${SLICE_WITH_CRITERIA}

---

### Slice 3: Group follow-up

**Why:** Grouped completeness must verify criteria across the whole increment.

**Files:** \`src/infrastructure/prompts/default-prompt-builder.ts\` (edit)

**Criteria:**
- Grouped completeness reports PASS/FAIL/DIVERGENT per criterion

Implement grouped criteria-aware completeness wording.

**Tests:** Cover grouped completeness criteria handling.`;

describe("DefaultPromptBuilder", () => {
  it("can be instantiated and is an instance of PromptBuilder", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder).toBeInstanceOf(PromptBuilder);
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

    expect(builder.plan("slice content", 3)).toBe(
      withBrief(buildPlanPrompt("slice content", PLAN_CONTENT, 3), BRIEF),
    );
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

  it("tddExecute first slice includes plan context and brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.tddExecute("the plan", 3, true)).toBe(
      withBrief(
        `## Full Plan Context\nYou are implementing Slice 3. Here is the full plan — do NOT implement other slices.\n\n${PLAN_CONTENT}\n\n---\n\nExecute this plan for Slice 3:\n\nthe plan`,
        BRIEF,
      ),
    );
  });

  it("tddExecute non-first slice omits plan context and brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const result = builder.tddExecute("the plan", 5, false, "check types");

    expect(result).toBe("Operator guidance: check types\n\nExecute this plan for Slice 5:\n\nthe plan");
    expect(result).not.toContain(PLAN_CONTENT);
    expect(result).not.toContain(BRIEF);
  });

  it("groupedExecute first group includes full-plan context and brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const result = builder.groupedExecute("Core", "group plan", true);

    expect(result).toContain("## Full Plan Context");
    expect(result).toContain(PLAN_CONTENT);
    expect(result).toContain("Execute this plan for Group Core as one bounded increment:");
    expect(result).toContain("group plan");
    expect(result).toContain(BRIEF);
  });

  it("groupedExecute later groups omit full-plan context and brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const result = builder.groupedExecute("Core", "group plan", false, "focus on integration");

    expect(result).toBe(
      "Operator guidance: focus on integration\n\nExecute this plan for Group Core as one bounded increment:\n\ngroup plan",
    );
  });

  it("groupedTestPass builds the mandatory group test-pass prompt", () => {
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

  it("direct prompt helpers delegate to the direct prompt builders", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.directVerify("sha", "request text", "fixed summary")).toBe(
      withBrief(buildDirectVerifyPrompt("sha", "request text", "fixed summary"), BRIEF),
    );
    expect(builder.directReview("request text", "sha", true)).toBe(
      buildDirectReviewPrompt("request text", "sha", true),
    );
    expect(builder.directCompleteness("request text", "sha")).toBe(
      withBrief(buildDirectCompletenessPrompt("request text", "sha"), BRIEF),
    );
    expect(builder.directGap("request text")).toBe(
      withBrief(buildDirectGapPrompt("request text"), BRIEF),
    );
    expect(builder.directFinalPasses("sha", "request text")).toEqual(
      buildDirectFinalPasses("sha", "request text"),
    );
  });

  it("verify includes base SHA via the shared verify prompt helper", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.verify("sha123", 1)).toBe(
      withBrief(buildVerifyPrompt("sha123", "Slice 1"), BRIEF),
    );
  });

  it("groupedVerify wraps buildVerifyPrompt output with brief", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.groupedVerify("sha", "Core")).toBe(
      withBrief(buildVerifyPrompt("sha", "Group Core"), BRIEF),
    );
  });

  it("review includes content and base SHA", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.review("content", "sha", true)).toBe(
      buildReviewPrompt("content", "sha", true),
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

  it("groupedCompleteness delegates to the grouped completeness helper", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.groupedCompleteness("group plan", "sha", "Core")).toBe(
      buildGroupedCompletenessPrompt("group plan", "sha", PLAN_CONTENT, "Core"),
    );
  });

  it("groupedCompleteness uses criteria-first wording when group content contains criteria", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);
    const result = builder.groupedCompleteness(GROUP_WITH_CRITERIA, "sha", "Core");

    expect(result).toContain("Inspect the `**Criteria:**` sections first");
    expect(result).toContain("Report PASS, FAIL, or DIVERGENT for each criterion");
    expect(result).toContain("GROUP_COMPLETE");
  });

  it("gap delegates to buildGapPrompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.gap("group", "sha")).toBe(buildGapPrompt("group", "sha"));
  });

  it("commitSweep delegates to buildCommitSweepPrompt", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.commitSweep("Auth")).toBe(buildCommitSweepPrompt("Auth"));
  });

  it("finalPasses returns FinalPass objects from the stored plan content", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.finalPasses("sha")).toEqual(buildFinalPasses("sha", PLAN_CONTENT));
  });

  it("rulesReminder uses the default reminders when no project overrides exist", () => {
    const builder = new DefaultPromptBuilder(BRIEF, PLAN_CONTENT);

    expect(builder.rulesReminder("tdd")).toBe(TDD_RULES_REMINDER);
    expect(builder.rulesReminder("review")).toBe(REVIEW_RULES_REMINDER);
  });

  it("rulesReminder appends project-specific overrides", () => {
    const builder = new DefaultPromptBuilder(
      BRIEF,
      PLAN_CONTENT,
      EXTRA_TDD_RULES,
      EXTRA_REVIEW_RULES,
    );

    expect(builder.rulesReminder("tdd")).toBe(
      buildRulesReminder(TDD_RULES_REMINDER, EXTRA_TDD_RULES),
    );
    expect(builder.rulesReminder("review")).toBe(
      buildRulesReminder(REVIEW_RULES_REMINDER, EXTRA_REVIEW_RULES),
    );
  });
});
