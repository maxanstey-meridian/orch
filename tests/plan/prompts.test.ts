import { describe, it, expect } from "vitest";
import {
  withBrief,
  buildTddPrompt,
  buildDirectExecutePrompt,
  buildDirectTestPassPrompt,
  buildReviewPreamble,
  buildReviewPrompt,
  buildCompletenessPrompt,
  buildGapPrompt,
  buildFinalPasses,
  buildCommitSweepPrompt,
  buildPlanPrompt,
  buildPlanGenerationPrompt,
} from "#infrastructure/plan/prompts.js";

const SLICE_WITH_CRITERIA = `### Slice 2: Criteria-aware prompts

**Why:** Prompt contracts need binary acceptance checks.

**Files:** \`src/infrastructure/plan/prompts.ts\` (edit)

**Criteria:**
- TDD prompt requires at least one regression guard per criterion
- Completeness prompt reports PASS/FAIL/DIVERGENT per criterion

Implement criteria-aware prompt wording.

**Tests:** Cover criteria-aware and legacy fallback wording.`;

const SLICE_WITHOUT_CRITERIA = `### Slice 2: Legacy prompts

**Why:** Legacy plans still need fallback wording.

**Files:** \`src/infrastructure/plan/prompts.ts\` (edit)

Keep legacy wording intact.

**Tests:** Cover legacy prompt wording.`;

const GROUP_WITH_CRITERIA = `${SLICE_WITH_CRITERIA}

---

### Slice 3: More criteria

**Why:** Gap analysis should prioritise criteria guards.

**Files:** \`skills/gap.md\` (edit)

**Criteria:**
- Gap prompt prioritises missing regression guards tied to criteria

Implement grouped criteria-aware gap wording.

**Tests:** Cover grouped criteria gap priorities.`;

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

  it("adds a mandatory per-criterion checklist and regression-guard requirement when criteria are present", () => {
    const result = buildTddPrompt(SLICE_WITH_CRITERIA);

    expect(result).toContain("For each criterion in the `**Criteria:**` section");
    expect(result).toContain("mandatory criteria coverage checklist");
    expect(result).toContain("at least one regression guard per criterion");
  });

  it("keeps the criteria checklist in fix mode when criteria are present", () => {
    const result = buildTddPrompt(SLICE_WITH_CRITERIA, "fix the unmet criteria");

    expect(result).toContain("fix the unmet criteria");
    expect(result).toContain("For each criterion in the `**Criteria:**` section");
    expect(result).toContain("at least one regression guard per criterion");
  });

  it("keeps legacy tdd wording when no criteria section exists", () => {
    const result = buildTddPrompt(SLICE_WITHOUT_CRITERIA);

    expect(result).toContain("RED");
    expect(result).toContain("GREEN");
    expect(result).not.toContain("## Criteria coverage");
    expect(result).not.toContain("For each criterion in the `**Criteria:**` section");
  });
});

describe("buildDirectExecutePrompt", () => {
  it("scopes the builder to the bounded whole request without slice or plan language", () => {
    const result = buildDirectExecutePrompt("implement direct mode");
    expect(result).toContain("bounded whole request");
    expect(result).toContain("keep scope narrow");
    expect(result).toContain("mandatory test pass");
    expect(result).not.toContain("Slice 1");
    expect(result).not.toContain("generated plan");
  });

  it("makes the direct-mode inference policy explicit", () => {
    const result = buildDirectExecutePrompt("implement direct mode");
    expect(result).toContain("Do not invent compatibility");
    expect(result).toContain("Do not add fail-open behavior");
    expect(result).toContain("Do not perform fake RED/GREEN ceremony");
  });
});

describe("buildDirectTestPassPrompt", () => {
  it("requires the mandatory test pass with useful-test audit details", () => {
    const result = buildDirectTestPassPrompt("implement direct mode");
    expect(result).toContain("mandatory test pass");
    expect(result).toContain("changed behavior");
    expect(result).toContain("regression risks");
    expect(result).toContain("tests added or updated");
    expect(result).toContain("why those tests are useful");
  });

  it("keeps the test pass scoped to the direct request without slice or group framing", () => {
    const result = buildDirectTestPassPrompt("implement direct mode");
    expect(result).toContain("implement direct mode");
    expect(result).not.toContain("Slice");
    expect(result).not.toContain("Group");
    expect(result).not.toContain("generated plan");
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

  it("tells first-pass reviewers to treat the pass as scarce and avoid padding", () => {
    const result = buildReviewPrompt("slice", "abc123");
    expect(result).toContain("Assume you may only get one useful review pass");
    expect(result).toContain("Surface the highest-signal issues now");
    expect(result).toContain("Do not pad the review");
  });

  it("tightens follow-up review passes to material missed issues only", () => {
    const result = buildReviewPrompt("slice", "abc123", "- **File and line** foo");
    expect(result).toContain("This is likely your final useful review pass");
    expect(result).toContain("only add a new issue if it is clearly material");
    expect(result).toContain("Do not hold back a material issue for a later pass");
  });

  it("requires a criteria check section only when criteria are present", () => {
    const criteriaResult = buildReviewPrompt(SLICE_WITH_CRITERIA, "abc123");
    const legacyResult = buildReviewPrompt(SLICE_WITHOUT_CRITERIA, "abc123");

    expect(criteriaResult).toContain("## Criteria check");
    expect(criteriaResult).toContain("Check each criterion in the `**Criteria:**` section");
    expect(criteriaResult).toContain("include a `## Criteria check` section in your output");
    expect(criteriaResult).toContain("REVIEW_CLEAN");
    expect(criteriaResult).not.toContain("for context, not as acceptance criteria");
    expect(legacyResult).toContain("for context, not as acceptance criteria");
    expect(legacyResult).not.toContain("## Criteria check");
  });
});

describe("buildGapPrompt", () => {
  it("includes group content and NO_GAPS_FOUND sentinel", () => {
    const result = buildGapPrompt("group content", "abc123");
    expect(result).toContain("group content");
    expect(result).toContain("NO_GAPS_FOUND");
  });

  it("tells gap review to batch high-signal findings and avoid padding", () => {
    const result = buildGapPrompt("group content", "abc123");
    expect(result).toContain("Assume this may be the only useful gap pass");
    expect(result).toContain("Report only the **highest-signal** gaps");
    expect(result).toContain("Do not hold back a material finding for later");
    expect(result).toContain("do not invent marginal findings");
  });

  it("prioritises missing regression guards tied to explicit criteria and keeps legacy fallback wording", () => {
    const criteriaResult = buildGapPrompt(GROUP_WITH_CRITERIA, "abc123");
    const legacyResult = buildGapPrompt(SLICE_WITHOUT_CRITERIA, "abc123");
    expect(criteriaResult).toContain("Prioritise missing regression guards tied to explicit criteria");
    expect(criteriaResult).toContain("ahead of generic edge-case ideas");
    expect(criteriaResult).toContain("NO_GAPS_FOUND");
    expect(legacyResult).toContain("Untested edge cases and boundary conditions");
    expect(legacyResult).not.toContain("Prioritise missing regression guards tied to explicit criteria");
  });
});

describe("buildCompletenessPrompt", () => {
  it("uses criteria-first verification when criteria are present and keeps legacy fallback wording otherwise", () => {
    const criteriaResult = buildCompletenessPrompt(SLICE_WITH_CRITERIA, "abc123", "full plan", 2);
    const legacyResult = buildCompletenessPrompt(SLICE_WITHOUT_CRITERIA, "abc123", "full plan", 2);

    expect(criteriaResult).toContain("Inspect the `**Criteria:**` section first");
    expect(criteriaResult).toContain("Report PASS, FAIL, or DIVERGENT for each criterion");
    expect(criteriaResult).toContain("cite both code evidence and test evidence");
    expect(criteriaResult).toContain("SLICE_COMPLETE");
    expect(legacyResult).toContain("For EACH concrete requirement in the slice above");
    expect(legacyResult).not.toContain("Report PASS, FAIL, or DIVERGENT for each criterion");
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
