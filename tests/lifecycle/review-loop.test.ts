import { describe, it, expect } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
import type { Group, Slice } from "#domain/plan.js";

const makeSlice = (n: number): Slice => ({
  number: n,
  title: `Slice ${n}`,
  content: `content for slice ${n}`,
  why: `reason ${n}`,
  files: [{ path: `src/s${n}.ts`, action: "new" }],
  details: `details ${n}`,
  tests: `tests ${n}`,
});

const makeGroup = (name: string, slices: Slice[]): Group => ({ name, slices });

const hasPhaseSubsequence = (
  phases: readonly (string | undefined)[],
  expected: readonly string[],
): boolean => {
  let expectedIndex = 0;

  for (const phase of phases) {
    if (phase === expected[expectedIndex]) {
      expectedIndex += 1;
      if (expectedIndex === expected.length) {
        return true;
      }
    }
  }

  return false;
};

describe("Review loop lifecycle", () => {
  it("review clean on first cycle, slice completes", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, verifySkill: null },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    // TDD: implementation + slice summary
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "summary" }), // slice summary (sendQuiet won't consume this)
    );

    // Review: clean
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN — no issues found" }));

    // Completeness: complete
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
  });

  it("review finds issues, TDD fixes, second review clean", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, verifySkill: null },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    // TDD: implementation + fix after review + summary
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fixed review issues" }),
      okResult({ assistantText: "summary" }),
    );

    // Review: first has issues, second is clean
    spawner.onNextSpawn("review",
      okResult({ assistantText: "Found issues: missing null check in handler" }),
      okResult({ assistantText: "REVIEW_CLEAN" }),
    );

    // Completeness: complete
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // TDD received at least a fix prompt
    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts.length).toBeGreaterThanOrEqual(2);
  });

  it("persists review and tdd phases across a review-fix retry", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, verifySkill: null },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fixed review issues" }),
    );
    spawner.onNextSpawn("review",
      okResult({ assistantText: "Found issues: missing null check in handler" }),
      okResult({ assistantText: "REVIEW_CLEAN" }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(
      hasPhaseSubsequence(
        persistence.saveHistory.map((state) => state.currentPhase),
        ["review", "tdd", "review"],
      ),
    ).toBe(true);
  });

  it("max review cycles exhausted, slice still completes", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, verifySkill: null, maxReviewCycles: 2 },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    // TDD: implementation + 2 fixes + summary
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fix attempt 1" }),
      okResult({ assistantText: "fix attempt 2" }),
      okResult({ assistantText: "summary" }),
    );

    // Review: always finds issues
    spawner.onNextSpawn("review",
      okResult({ assistantText: "Issues: problem A" }),
      okResult({ assistantText: "Issues: problem B still there" }),
    );

    // Completeness
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
  });

  it("grouped mode reviews the whole group once per cycle and fixes against aggregated group content", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { executionMode: "grouped", planDisabled: true, gapDisabled: true, verifySkill: null },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented grouped increment" }),
      okResult({ assistantText: "ran grouped mandatory test pass" }),
      okResult({ assistantText: "fixed grouped review issues" }),
    );
    spawner.onNextSpawn(
      "review",
      okResult({ assistantText: "Found issues: missing grouped boundary assertion" }),
      okResult({ assistantText: "REVIEW_CLEAN" }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "GROUP_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])]);

    expect(persistence.current.lastCompletedSlice).toBe(2);
    expect(
      hasPhaseSubsequence(
        persistence.saveHistory.map((state) => state.currentPhase),
        ["review", "tdd", "review"],
      ),
    ).toBe(true);

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts[0]).toContain("[GROUP_EXEC:G1]");
    expect(tdd.sentPrompts[1]).toContain("[GROUP_TEST_PASS:G1]");
    expect(tdd.sentPrompts[2]).toContain("content for slice 1");
    expect(tdd.sentPrompts[2]).toContain("content for slice 2");
    expect(spawner.lastAgent("review").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("completeness").sentPrompts[0]).toContain("[GROUP_COMPLETENESS:G1]");
  });

  it("direct mode fixes review findings against the whole request without persisting slice completion", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { executionMode: "direct", gapDisabled: true, verifySkill: null },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented direct request" }),
      okResult({ assistantText: "ran direct mandatory test pass" }),
      okResult({ assistantText: "fixed direct review issues" }),
    );
    spawner.onNextSpawn(
      "review",
      okResult({ assistantText: "Found issues: missing direct request assertion" }),
      okResult({ assistantText: "REVIEW_CLEAN" }),
    );
    spawner.onNextSpawn("triage", okResult({
      assistantText: JSON.stringify({
        completeness: true,
        verify: false,
        review: true,
        gap: false,
        reason: "direct review path",
      }),
    }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "DIRECT_COMPLETE" }));

    await uc.execute([makeGroup("Direct", [makeSlice(1)])]);

    expect(
      hasPhaseSubsequence(
        persistence.saveHistory.map((state) => state.currentPhase),
        ["review", "tdd", "review"],
      ),
    ).toBe(true);
    expect((persistence.current as Record<string, unknown>).executionMode).toBe("direct");
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
    expect(persistence.current.lastCompletedGroup).toBeUndefined();

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts[0]).toContain("[DIRECT]");
    expect(tdd.sentPrompts[1]).toContain("[DIRECT_TEST_PASS]");
    expect(tdd.sentPrompts[2]).toContain("content for slice 1");
    expect(tdd.sentPrompts[2]).toContain("missing direct request assertion");
    expect(spawner.lastAgent("review").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("completeness").sentPrompts[0]).toContain("Direct request");
    expect(spawner.lastAgent("completeness").sentPrompts[0]).not.toContain("Slice 1");
  });
});
