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

const verifyJson = (status: "PASS" | "FAIL", summary: string, failures: readonly string[] = []): string =>
  `### VERIFY_JSON
\`\`\`json
${JSON.stringify({
  status,
  checks: [{ check: "npx vitest run", status: status === "PASS" ? "PASS" : "FAIL" }],
  sliceLocalFailures: [...failures],
  outOfScopeFailures: [],
  preExistingFailures: [],
  runnerIssue: null,
  retryable: status === "FAIL",
  summary,
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

describe("pipeline verify loop", () => {
  it("re-runs verify after a tdd fix and completes the slice", async () => {
    const harness = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    harness.git.setHasChanges(true);
    harness.spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented slice" }),
      okResult({ assistantText: "fixed test_foo" }),
    );
    harness.spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText: verifyJson(
          "FAIL",
          "Verification found slice-local failures.",
          ["- test_foo broke"],
        ),
      }),
      okResult({ assistantText: verifyJson("PASS", "Verification passed.") }),
    );
    harness.spawner.onNextSpawn(
      "completeness",
      okResult({ assistantText: "SLICE_COMPLETE" }),
    );

    await harness.execute([makeGroup("Core", [makeSlice(1)])]);

    const tdd = harness.spawner.lastAgent("tdd");
    expect(tdd.sentPrompts).toHaveLength(2);
    expect(tdd.sentPrompts[1]).toContain("test_foo broke");

    const verify = harness.spawner.lastAgent("verify");
    expect(verify.sentPrompts).toHaveLength(2);
    expect(verify.sentPrompts[1]).toContain("FIX: - test_foo broke");

    expect(hasPhaseSubsequence(
      harness.persistence.saveHistory.map((state) => state.currentPhase),
      ["verify", "tdd", "verify"],
    )).toBe(true);
    expect(harness.persistence.current.lastCompletedSlice).toBe(1);
  });
});
