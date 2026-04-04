import { describe, it, expect } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
import { IncompleteRunError } from "#domain/errors.js";
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

const verifyJson = (overrides?: Partial<{
  status: "PASS" | "FAIL" | "PASS_WITH_WARNINGS";
  checks: Array<{ check: string; status: "PASS" | "FAIL" | "WARN" | "SKIPPED" }>;
  sliceLocalFailures: string[];
  outOfScopeFailures: string[];
  preExistingFailures: string[];
  runnerIssue: string | null;
  retryable: boolean;
  summary: string;
}>): string => `### VERIFY_JSON
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
  ...overrides,
}, null, 2)}
\`\`\``;

const VERIFY_PASS = verifyJson();
const VERIFY_FAIL = verifyJson({
  status: "FAIL",
  checks: [{ check: "npx vitest run", status: "FAIL" }],
  sliceLocalFailures: ["- test_foo broke"],
  retryable: true,
  summary: "Verification found slice-local failures.",
});

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

describe("Verify loop lifecycle", () => {
  it("verify passes first try, slice completes normally", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_PASS }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    // No verifyFailed prompt
    const verifyPrompts = hud.askPrompts.filter((p) => p.includes("verification failed"));
    expect(verifyPrompts.length).toBe(0);
  });

  it("verify fails, TDD fixes, re-verify passes", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    git.setHasChanges(true); // TDD made changes after fix

    // TDD: implementation + fix attempt
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fixed the failing test" }),
    );
    spawner.onNextSpawn("review");

    // Verify: first FAIL, then PASS (re-verify after TDD fix)
    spawner.onNextSpawn("verify",
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_PASS }),
    );

    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // TDD received a fix prompt containing the failure detail
    const tdd = spawner.lastAgent("tdd");
    // The verify loop sends the failure text to TDD as a fix instruction
    expect(tdd.sentPrompts.length).toBeGreaterThanOrEqual(2);
    // Second prompt should be a fix prompt (contains failure info)
    const fixPrompt = tdd.sentPrompts[1];
    expect(fixPrompt).toContain("test_foo");
  });

  it("auto mode retries verify failures up to the shared retry budget", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null }, maxReviewCycles: 3 },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fix attempt 1" }),
      okResult({ assistantText: "fix attempt 2" }),
      okResult({ assistantText: "fix attempt 3" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "verify",
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_PASS }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts.length).toBeGreaterThanOrEqual(3);
  });

  it("persists verify and tdd phases across a verify-fix retry", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fixed the failing test" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify",
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_PASS }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(
      hasPhaseSubsequence(
        persistence.saveHistory.map((state) => state.currentPhase),
        ["verify", "tdd", "verify"],
      ),
    ).toBe(true);
  });

  it("verify fails, TDD makes no changes, operator chooses retry then passes", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
    });

    git.setHasChanges(true);
    git.queueHasChanges(true, false);

    // TDD: implementation + two fix attempts
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "tried to fix" }),
      okResult({ assistantText: "actually fixed it" }),
    );
    spawner.onNextSpawn("review");

    // Verify: FAIL → (TDD makes no changes, operator retries) → FAIL → (TDD fixes) → PASS
    spawner.onNextSpawn("verify",
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_PASS }),
    );

    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    // Operator: retry when verification fails with no changes
    hud.queueAskAnswer("r");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    const verifyPrompts = hud.askPrompts.filter((p) => p.includes("verification failed"));
    expect(verifyPrompts.length).toBeGreaterThanOrEqual(1);
  });

  it("verify fails, operator chooses skip, throws IncompleteRunError", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
    });

    // Initial hasChanges=true (so runSlice doesn't skip), but after TDD fix attempt → false (no real changes)
    git.queueHasChanges(true); // completenessCheck: hasChanges check
    git.setHasChanges(false);  // verify loop: TDD made no changes → gate fires

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "tried to fix" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_FAIL }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    // Operator: skip
    hud.queueAskAnswer("s");

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(IncompleteRunError);
  });

  it("verify fails, operator chooses stop, throws IncompleteRunError", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
    });

    git.queueHasChanges(true); // completenessCheck
    git.setHasChanges(false);  // verify loop: TDD made no changes → gate fires

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "tried to fix" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_FAIL }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    // Operator: stop
    hud.queueAskAnswer("t");

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(IncompleteRunError);
  });

  it("grouped mode re-sends verify failures against the current group only when slice-local failures exist", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: {
        executionMode: "grouped",
        skills: { plan: null, gap: null, review: null },
      },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented grouped increment" }),
      okResult({ assistantText: "mandatory grouped test pass" }),
      okResult({ assistantText: "fixed grouped verify issues" }),
    );
    spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText: verifyJson({
          status: "FAIL",
          checks: [{ check: "npx vitest run", status: "FAIL" }],
          sliceLocalFailures: ["- grouped regression in shared boundary"],
          retryable: true,
          summary: "Grouped verification found slice-local failures.",
        }),
      }),
      okResult({ assistantText: VERIFY_PASS }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness", okResult({ assistantText: "GROUP_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])]);

    expect(persistence.current.lastCompletedSlice).toBe(2);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("[GROUP_VERIFY:G1]");
    expect(spawner.lastAgent("verify").sentPrompts[1]).toContain("[GROUP_VERIFY:G1]");

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts).toHaveLength(3);
    expect(tdd.sentPrompts[2]).toContain("grouped regression in shared boundary");
    expect(tdd.sentPrompts[2]).toContain("content for slice 1");
    expect(tdd.sentPrompts[2]).toContain("content for slice 2");
  });

  it("direct mode re-sends verify failures against the whole request only when slice-local failures exist", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: {
        executionMode: "direct",
        skills: { gap: null, review: null },
      },
      auto: true,
    });

    git.setHasChanges(true);
    git.getDiff = async () => "diff --git a/src/direct.ts b/src/direct.ts";

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented direct request" }),
      okResult({ assistantText: "ran direct mandatory test pass" }),
      okResult({ assistantText: "fixed direct verify issues" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "triage",
      okResult({
        assistantText: JSON.stringify({
          completeness: false,
          verify: true,
          review: false,
          gap: false,
          reason: "direct verify path",
        }),
      }),
    );
    spawner.onNextSpawn(
      "verify",
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_PASS }),
    );

    await uc.execute([makeGroup("Direct", [makeSlice(1)])]);

    expect((persistence.current as Record<string, unknown>).executionMode).toBe("direct");
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(2);

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts).toHaveLength(3);
    expect(tdd.sentPrompts[0]).toContain("[DIRECT]");
    expect(tdd.sentPrompts[1]).toContain("[DIRECT_TEST_PASS]");
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("Direct request");
    expect(spawner.lastAgent("verify").sentPrompts[0]).not.toContain("Slice 1");
    expect(tdd.sentPrompts[2]).toContain("content for slice 1");
    expect(tdd.sentPrompts[2]).toContain("Current direct request");
    expect(tdd.sentPrompts[2]).not.toContain("Current slice content");
    expect(tdd.sentPrompts[2]).toContain("test_foo");
  });

  it("auto mode stops cleanly when verification reports only out-of-scope failures", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText: verifyJson({
          status: "FAIL",
          checks: [{ check: "npx vitest run", status: "FAIL" }],
          sliceLocalFailures: [],
          outOfScopeFailures: ["- unrelated fixture is already broken"],
          retryable: false,
          summary: "Verification found only out-of-scope failures.",
        }),
      }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(
      "Slice 1 verification failed: Verification found only out-of-scope failures.",
    );

    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(1);
  });

  it.each([
    {
      name: "out-of-scope failures",
      verifyResult: verifyJson({
        status: "FAIL",
        checks: [{ check: "npx vitest run", status: "FAIL" }],
        sliceLocalFailures: [],
        outOfScopeFailures: ["- unrelated fixture is already broken"],
        retryable: false,
        summary: "Verification found only out-of-scope failures.",
      }),
      expectedMessage: "Direct request verification failed: Verification found only out-of-scope failures.",
    },
    {
      name: "a runner issue",
      verifyResult: verifyJson({
        status: "FAIL",
        checks: [{ check: "npx vitest run", status: "WARN" }],
        sliceLocalFailures: [],
        outOfScopeFailures: [],
        preExistingFailures: [],
        runnerIssue: "Vitest worker hung before any assertions completed.",
        retryable: false,
        summary: "Verification could not complete because the runner was unstable.",
      }),
      expectedMessage: "Direct request verification failed: Verification could not complete because the runner was unstable.",
    },
  ])("direct mode stops cleanly when verification reports only $name", async ({ verifyResult, expectedMessage }) => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { executionMode: "direct", skills: { gap: null, review: null } },
      auto: true,
    });

    git.setHasChanges(true);
    git.getDiff = async () => "diff --git a/src/direct.ts b/src/direct.ts";

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented direct request" }),
      okResult({ assistantText: "ran direct mandatory test pass" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "triage",
      okResult({
        assistantText: JSON.stringify({
          completeness: false,
          verify: true,
          review: false,
          gap: false,
          reason: "direct verify path",
        }),
      }),
    );
    spawner.onNextSpawn("verify", okResult({ assistantText: verifyResult }));

    await expect(uc.execute([makeGroup("Direct", [makeSlice(1)])])).rejects.toThrow(expectedMessage);

    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("Direct request");
    expect(spawner.lastAgent("verify").sentPrompts[0]).not.toContain("Slice 1");
  });

  it("grouped mode stops cleanly when verification reports only out-of-scope failures", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: {
        executionMode: "grouped",
        skills: { plan: null, gap: null, review: null },
      },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented grouped increment" }),
      okResult({ assistantText: "mandatory grouped test pass" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText: verifyJson({
          status: "FAIL",
          checks: [{ check: "npx vitest run", status: "FAIL" }],
          sliceLocalFailures: [],
          outOfScopeFailures: ["- unrelated fixture is already broken"],
          retryable: false,
          summary: "Grouped verification found only out-of-scope failures.",
        }),
      }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "GROUP_COMPLETE" }));

    await expect(uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])])).rejects.toThrow(
      "Group G1 verification failed: Grouped verification found only out-of-scope failures.",
    );

    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("[GROUP_VERIFY:G1]");
  });

  it("auto mode stops cleanly when verification reports only pre-existing failures", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText: verifyJson({
          status: "FAIL",
          checks: [{ check: "npx vitest run", status: "WARN" }],
          sliceLocalFailures: [],
          outOfScopeFailures: [],
          preExistingFailures: ["- flaky queue-store test was already failing"],
          runnerIssue: null,
          retryable: false,
          summary: "Verification found only pre-existing failures.",
        }),
      }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(
      "Slice 1 verification failed: Verification found only pre-existing failures.",
    );

    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(1);
  });

  it("auto mode stops cleanly when verification reports only a runner issue", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText: verifyJson({
          status: "FAIL",
          checks: [{ check: "npx vitest run", status: "WARN" }],
          sliceLocalFailures: [],
          outOfScopeFailures: [],
          preExistingFailures: [],
          runnerIssue: "Vitest worker hung before any assertions completed.",
          retryable: false,
          summary: "Verification could not complete because the runner was unstable.",
        }),
      }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(
      "Slice 1 verification failed: Verification could not complete because the runner was unstable.",
    );

    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(1);
  });

  it("grouped mode stops cleanly when verification reports only a runner issue", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: {
        executionMode: "grouped",
        skills: { plan: null, gap: null, review: null },
      },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented grouped increment" }),
      okResult({ assistantText: "mandatory grouped test pass" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText: verifyJson({
          status: "FAIL",
          checks: [{ check: "npx vitest run", status: "WARN" }],
          sliceLocalFailures: [],
          outOfScopeFailures: [],
          preExistingFailures: [],
          runnerIssue: "Vitest worker hung before any assertions completed.",
          retryable: false,
          summary: "Grouped verification could not complete because the runner was unstable.",
        }),
      }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "GROUP_COMPLETE" }));

    await expect(uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])])).rejects.toThrow(
      "Group G1 verification failed: Grouped verification could not complete because the runner was unstable.",
    );

    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("[GROUP_VERIFY:G1]");
  });

  it("auto mode stops after a builder-fixable verify failure when the builder makes no relevant change", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { skills: { plan: null, gap: null, review: null } },
      auto: true,
    });

    git.queueHasChanges(true);
    git.setHasChanges(false);

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "attempted verify fix but changed nothing" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_FAIL }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(
      "Slice 1 verification failed without builder changes",
    );

    expect(hud.askPrompts.filter((prompt) => prompt.includes("verification failed"))).toHaveLength(0);
    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("verify").sentPrompts).toHaveLength(1);
  });
});
