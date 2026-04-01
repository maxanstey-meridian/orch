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
});
