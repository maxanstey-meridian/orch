import { describe, expect, it } from "vitest";
import type { Group, Slice } from "#domain/plan.js";
import { createTestHarness, okResult } from "../fakes/harness.js";

const makeSlice = (number: number): Slice => ({
  number,
  title: `Slice ${number}`,
  content: `content for slice ${number}`,
  why: `reason ${number}`,
  files: [{ path: `src/s${number}.ts`, action: "edit" }],
  details: `details ${number}`,
  tests: `tests ${number}`,
});

const makeGroup = (name: string, slices: readonly Slice[]): Group => ({
  name,
  slices: [...slices],
});

const verifyPass = (): string => `### VERIFY_JSON
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

describe("pipeline boundary policy", () => {
  it("runs verify immediately, defers review, skips gap, and flushes deferred review at group end", async () => {
    const harness = createTestHarness({
      config: { skills: { plan: null, completeness: null, gap: "test" } },
      auto: true,
    });

    harness.git.setHasChanges(true);
    harness.git.setDiffStats({ added: 20, removed: 5, total: 25 });
    harness.triager.queueResult({
      completeness: "skip",
      verify: "run_now",
      review: "defer",
      gap: "skip",
      reason: "mixed boundary policy",
    }, {
      completeness: "skip",
      verify: "skip",
      review: "skip",
      gap: "skip",
      reason: "second slice boundary",
    });

    harness.spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented slice 1" }),
      () => {
        const verify = harness.spawner.lastAgent("verify");
        expect(verify.sentPrompts).toHaveLength(1);

        const review = harness.spawner.agentsForRole("review");
        expect(review).toHaveLength(1);
        expect(review[0].sentPrompts).toHaveLength(0);

        return okResult({ assistantText: "implemented slice 2" });
      },
    );
    harness.spawner.onNextSpawn("verify", okResult({ assistantText: verifyPass() }));
    harness.spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));

    await harness.execute([makeGroup("Core", [makeSlice(1), makeSlice(2)])]);

    expect(harness.spawner.agentsForRole("verify")).toHaveLength(1);
    expect(harness.spawner.lastAgent("verify").sentPrompts[0]).toContain("[VERIFY:1]");
    expect(harness.spawner.agentsForRole("gap")).toHaveLength(0);

    const review = harness.spawner.lastAgent("review");
    expect(review.sentPrompts).toHaveLength(1);
    expect(review.sentPrompts[0]).toContain("[REVIEW]");

    expect(harness.persistence.saveHistory.some((state) => state.pendingReviewBaseSha === "sha-0")).toBe(true);
    expect(harness.persistence.current.pendingReviewBaseSha).toBeUndefined();
  });
});
