import { describe, expect, it } from "vitest";
import type { Group, Slice } from "#domain/plan.js";
import { createTestHarness, okResult } from "../fakes/harness.js";

const makeSlice = (number: number): Slice => ({
  number,
  title: `Slice ${number}`,
  content: `content for slice ${number}`,
  why: `reason ${number}`,
  files: [{ path: `src/s${number}.ts`, action: "new" }],
  details: `details ${number}`,
  tests: `tests ${number}`,
});

const makeGroup = (name: string, slices: readonly Slice[]): Group => ({
  name,
  slices: [...slices],
});

const verifyJson = (): string => `### VERIFY_JSON
\`\`\`json
${JSON.stringify({
  status: "PASS",
  checks: [{ check: "npx vitest run", status: "PASS" }],
  sliceLocalFailures: [],
  outOfScopeFailures: [],
  preExistingFailures: [],
  runnerIssue: null,
  retryable: false,
  summary: "Verification passed.",
}, null, 2)}
\`\`\``;

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

describe("pipeline happy path", () => {
  it("runs two sliced units through plan, execute, completeness, verify, review, and final passes", async () => {
    const harness = createTestHarness({
      config: { skills: { gap: null } },
    });

    harness.git.setHasChanges(true);
    harness.git.setDiffStats({ added: 50, removed: 10, total: 60 });
    harness.hud.queueAskAnswer("y", "y");
    harness.prompts.finalPassesOverride = [{ name: "final-audit", prompt: "[FINAL_AUDIT]" }];

    harness.spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "plan 1", planText: "plan 1" }),
      okResult({ assistantText: "implemented 1" }),
      okResult({ assistantText: "plan 2", planText: "plan 2" }),
      okResult({ assistantText: "implemented 2" }),
    );
    harness.spawner.onNextSpawn(
      "review",
      okResult({ assistantText: "REVIEW_CLEAN" }),
      okResult({ assistantText: "REVIEW_CLEAN" }),
    );
    harness.spawner.onNextSpawn(
      "verify",
      okResult({ assistantText: verifyJson() }),
      okResult({ assistantText: verifyJson() }),
    );
    harness.spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    harness.spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    harness.spawner.onNextSpawn(
      "final",
      okResult({ assistantText: "NO_ISSUES_FOUND" }),
    );

    await harness.execute([makeGroup("Core", [makeSlice(1), makeSlice(2)])]);

    const tdd = harness.spawner.lastAgent("tdd");
    expect(tdd.sentPrompts).toEqual([
      expect.stringContaining("[PLAN:1]"),
      expect.stringContaining("[EXEC:1]"),
      expect.stringContaining("[PLAN:2]"),
      expect.stringContaining("[EXEC:2]"),
    ]);
    expect(harness.spawner.agentsForRole("completeness")).toHaveLength(2);
    expect(harness.spawner.agentsForRole("completeness")[0].sentPrompts[0]).toContain("[COMPLETENESS:1]");
    expect(harness.spawner.agentsForRole("completeness")[1].sentPrompts[0]).toContain("[COMPLETENESS:2]");
    expect(harness.spawner.lastAgent("verify").sentPrompts).toEqual([
      expect.stringContaining("[VERIFY:1]"),
      expect.stringContaining("[VERIFY:2]"),
    ]);
    expect(harness.spawner.lastAgent("review").sentPrompts).toEqual([
      expect.stringContaining("[REVIEW]"),
      expect.stringContaining("[REVIEW]"),
    ]);
    expect(harness.spawner.lastAgent("final").sentPrompts[0]).toContain("[BRIEF] [FINAL_AUDIT]");

    expect(hasPhaseSubsequence(
      harness.persistence.saveHistory.map((state) => state.currentPhase),
      ["plan", "tdd", "completeness", "verify", "review", "final"],
    )).toBe(true);
    expect(harness.persistence.saveHistory.some((state) => state.lastCompletedSlice === 1)).toBe(true);
    expect(harness.persistence.current.lastCompletedSlice).toBe(2);
    expect(harness.persistence.current.currentPhase).toBeUndefined();
  });
});
