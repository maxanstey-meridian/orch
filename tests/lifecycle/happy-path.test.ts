import { describe, it, expect, vi } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
import type { Group, Slice } from "#domain/plan.js";
import { formatExecutionModeSummary } from "#ui/display.js";

const makeSlice = (n: number, title = `Slice ${n}`): Slice => ({
  number: n,
  title,
  content: `content for slice ${n}`,
  why: `reason for slice ${n}`,
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

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

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


describe("Happy path lifecycle", () => {
  it("single slice completes through plan-execute-verify-review", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: { skills: { gap: null } },
    });

    // Git reports changes so verify/review run
    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    // Plan agent: returns a plan
    spawner.onNextSpawn("plan", okResult({ assistantText: "Here is the plan", planText: "plan text" }));

    // HUD: accept the plan, then confirm nothing else
    hud.queueAskAnswer("y");

    // TDD agent: returns successful implementation (spawned as long-lived, gets rules + execute)
    spawner.onNextSpawn("tdd",
      okResult(), // rules reminder (sendQuiet)
      okResult({ assistantText: "implemented slice 1" }), // tddExecute
      okResult({ assistantText: "summary done" }), // slice summary
    );

    // Review agent: returns clean review (long-lived, gets rules + review)
    spawner.onNextSpawn("review",
      okResult(), // rules reminder (sendQuiet)
      okResult({ assistantText: "REVIEW_CLEAN" }),
    );

    // Verify agent: returns PASS
    spawner.onNextSpawn("verify",
      okResult({ assistantText: verifyJson() }),
    );

    // Completeness agent: returns complete
    spawner.onNextSpawn("completeness",
      okResult({ assistantText: "SLICE_COMPLETE" }),
    );

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await uc.execute(groups);

    // State advanced
    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(persistence.current.currentPhase).toBeUndefined();
    expect(persistence.saveHistory.some((state) => state.currentPhase === "plan")).toBe(true);
    expect(persistence.saveHistory.some((state) => state.currentPhase === "tdd")).toBe(true);
    expect(persistence.saveHistory.some((state) => state.currentPhase === "verify")).toBe(true);
    expect(persistence.saveHistory.some((state) => state.currentPhase === "review")).toBe(true);

    // Agents were spawned for the right roles
    expect(spawner.agentsForRole("plan").length).toBeGreaterThanOrEqual(1);
    expect(spawner.agentsForRole("tdd").length).toBe(1);
    expect(spawner.agentsForRole("verify").length).toBe(1);
    expect(spawner.agentsForRole("review").length).toBe(1);
  });

  it("two slices in one group both complete with plan disabled", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    // TDD: needs responses for rules + slice 1 + slice 2
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "slice 1 done" }),
      okResult({ assistantText: "slice 2 done" }),
    );

    // Review agent spawned but won't be used (review disabled)
    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1), makeSlice(2)])];
    await uc.execute(groups);

    expect(persistence.current.lastCompletedSlice).toBe(2);

    const tddAgents = spawner.agentsForRole("tdd");
    expect(tddAgents.length).toBe(1);
    expect(tddAgents[0].sentPrompts.length).toBe(2);
  });

  it("grouped mode runs one execute/test-pass/review/verify/completeness cadence for the whole group", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: {
        executionMode: "grouped",
        skills: { plan: null, gap: null },
      },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented grouped unit" }),
      okResult({ assistantText: "ran grouped mandatory test pass" }),
    );
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: verifyJson() }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "GROUP_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])]);

    expect(persistence.current.lastCompletedSlice).toBe(2);
    expect(persistence.current.lastCompletedGroup).toBe("G1");
    expect(spawner.agentsForRole("verify")).toHaveLength(1);
    expect(spawner.agentsForRole("completeness")).toHaveLength(1);

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts).toHaveLength(2);
    expect(tdd.sentPrompts[0]).toContain("[GROUP_EXEC:G1]");
    expect(tdd.sentPrompts[1]).toContain("[GROUP_TEST_PASS:G1]");
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("[GROUP_VERIFY:G1]");
    expect(spawner.lastAgent("completeness").sentPrompts[0]).toContain("[GROUP_COMPLETENESS:G1]");
    expect(spawner.lastAgent("review").sentPrompts).toHaveLength(1);
  });

  it("grouped mode captures the group-entry diff base and runs triage and gap once for the whole group", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: {
        executionMode: "grouped",
        skills: { plan: null, verify: null, review: null, gap: "test" },
      },
      auto: true,
    });

    git.setHasChanges(true);
    git.captureRef = vi
      .fn()
      .mockResolvedValueOnce("run-base")
      .mockResolvedValueOnce("group-base")
      .mockResolvedValueOnce("after-tdd")
      .mockResolvedValueOnce("after-review");
    git.getDiff = vi.fn().mockResolvedValue("diff --git a/src/group.ts b/src/group.ts");

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented grouped unit" }),
      okResult({ assistantText: "ran grouped mandatory test pass" }),
    );
    spawner.onNextSpawn(
      "triage",
      okResult({
        assistantText: JSON.stringify({
          completeness: true,
          verify: false,
          review: false,
          gap: true,
          reason: "group-level cadence",
        }),
      }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness", okResult({ assistantText: "GROUP_COMPLETE" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));

    await uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])]);

    expect(persistence.current.lastCompletedSlice).toBe(2);
    expect(spawner.agentsForRole("triage")).toHaveLength(1);
    expect(spawner.agentsForRole("gap")).toHaveLength(1);
    expect(git.getDiff).toHaveBeenCalledTimes(1);
    expect(git.getDiff).toHaveBeenCalledWith("group-base");
    expect(spawner.lastAgent("completeness").sentPrompts[0]).toContain("[GROUP_COMPLETENESS:G1] from=group-base");
    expect(spawner.lastAgent("gap").sentPrompts[0]).toContain("[GAP] from=group-base");
  });

  it("persists slice and phase progress for an active slice without mutating earlier saves", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 1 done" }));
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    const tddPhaseSave = persistence.saveHistory.find((state) => state.currentPhase === "tdd");

    expect(tddPhaseSave).toEqual(
      expect.objectContaining({
        executionMode: "sliced",
        currentPhase: "tdd",
        currentSlice: 1,
        currentGroup: "G1",
        startedAt: expect.any(String),
        tddSession: { provider: "claude", id: expect.any(String) },
        reviewSession: { provider: "claude", id: expect.any(String) },
        sliceTimings: [{ number: 1, startedAt: expect.any(String) }],
      }),
    );
    expect(tddPhaseSave?.completedAt).toBeUndefined();
    expect(tddPhaseSave?.sliceTimings?.[0]?.completedAt).toBeUndefined();
    expect(persistence.current.sliceTimings).toEqual([
      {
        number: 1,
        startedAt: tddPhaseSave?.sliceTimings?.[0]?.startedAt,
        completedAt: expect.any(String),
      },
    ]);
    expect(persistence.current.startedAt).toBe(tddPhaseSave?.startedAt);
  });

  it("persists gap and final phases when those passes run", async () => {
    const { uc, spawner, persistence, git, prompts } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: "test" } },
      auto: true,
    });

    git.setHasChanges(true);
    git.getDiff = vi.fn().mockResolvedValue("diff --git a/src/direct-final.ts b/src/direct-final.ts");
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "check final state" }];

    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 1 done" }));
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "NO_ISSUES_FOUND" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.saveHistory.some((state) => state.currentPhase === "gap")).toBe(true);
    expect(persistence.saveHistory.some((state) => state.currentPhase === "final")).toBe(true);
    expect(persistence.current.currentPhase).toBeUndefined();
  });

  it("resumes group finalization when all slices are done but groupDone was never persisted", async () => {
    const { uc, spawner, persistence, git, prompts } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: "test" } },
      state: {
        lastCompletedSlice: 1,
        lastSliceImplemented: 1,
      },
      auto: true,
    });

    git.setHasChanges(true);
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "check final state" }];

    spawner.onNextSpawn("tdd", okResult());
    spawner.onNextSpawn("review", okResult());
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "NO_ISSUES_FOUND" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(persistence.current.lastCompletedGroup).toBe("G1");
    expect(persistence.saveHistory.some((state) => state.currentPhase === "gap")).toBe(true);
    expect(persistence.saveHistory.some((state) => state.currentPhase === "final")).toBe(true);
  });

  it("persists verify and tdd phases when completeness sends fixes back to TDD", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "slice 1 done" }),
      okResult({ assistantText: "completed missing work" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn(
      "completeness",
      okResult({ assistantText: "❌ Missing required assertion for slice coverage" }),
    );
    spawner.onNextSpawn(
      "completeness",
      okResult({ assistantText: "SLICE_COMPLETE" }),
    );

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(
      hasPhaseSubsequence(
        persistence.saveHistory.map((state) => state.currentPhase),
        ["verify", "tdd"],
      ),
    ).toBe(true);
  });

  it("auto mode retries completeness findings until they are closed", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null }, maxReviewCycles: 3 },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "slice 1 done" }),
      okResult({ assistantText: "fixed completeness issue 1" }),
      okResult({ assistantText: "fixed completeness issue 2" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness", okResult({ assistantText: "❌ Missing completeness guard 1" }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "❌ Missing completeness guard 2" }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(
      persistence.saveHistory.filter((state) => state.currentPhase === "verify").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("auto mode retries gap findings until the gap pass is clean", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: "test" }, maxReviewCycles: 3 },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "slice 1 done" }),
      okResult({ assistantText: "added missing gap test 1" }),
      okResult({ assistantText: "added missing gap test 2" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "Gap 1" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "Gap 2" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(
      persistence.saveHistory.filter((state) => state.currentPhase === "gap").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("auto mode retries final-pass findings until the pass is clean", async () => {
    const { uc, spawner, persistence, git, prompts } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: "test" }, maxReviewCycles: 3 },
      auto: true,
    });

    git.setHasChanges(true);
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "check final state" }];

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "slice 1 done" }),
      okResult({ assistantText: "fixed final issue 1" }),
      okResult({ assistantText: "fixed final issue 2" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "Found issue in final pass output 1" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "Found issue in final pass output 2" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "NO_ISSUES_FOUND" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(
      persistence.saveHistory.filter((state) => state.currentPhase === "final").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("persists tdd phases after gap and final findings trigger fix loops", async () => {
    const { uc, spawner, persistence, git, prompts } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: "test" } },
      auto: true,
    });

    git.setHasChanges(true);
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "check final state" }];

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "slice 1 done" }),
      okResult({ assistantText: "added missing gap coverage" }),
      okResult({ assistantText: "addressed final-pass issue" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness",
      okResult({ assistantText: "SLICE_COMPLETE" }),
    );
    spawner.onNextSpawn("gap", okResult({ assistantText: "Missing queue coverage in follow-up path" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "Found issue in final pass output" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "NO_ISSUES_FOUND" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    const phaseHistory = persistence.saveHistory.map((state) => state.currentPhase);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(hasPhaseSubsequence(phaseHistory, ["gap", "tdd"])).toBe(true);
    expect(hasPhaseSubsequence(phaseHistory, ["final", "tdd"])).toBe(true);
  });

  it("does not advance into verify when the initial TDD execute throws immediately", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { skills: { gap: null } },
    });

    spawner.onNextSpawn("plan", okResult({ assistantText: "Here is the plan", planText: "plan text" }));
    hud.queueAskAnswer("y");
    spawner.onNextSpawn(
      "tdd",
      () => {
        throw new Error("tdd execute crashed");
      },
    );
    spawner.onNextSpawn("review");

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow("tdd execute crashed");
    expect(persistence.saveHistory.some((state) => state.currentPhase === "verify")).toBe(false);
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
  });

  it("two groups with inter-group confirmation and agent respawn", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
    });

    // First TDD + review (group 1)
    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 1 done" }));
    spawner.onNextSpawn("review");

    // After group 1: respawnBoth spawns fresh TDD + review (group 2)
    // Fresh agents get rules reminder (sendQuiet) then the actual slice
    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 2 done" }));
    spawner.onNextSpawn("review");

    // The confirmNextGroup prompt also needs an answer — already queued above

    // Gate: confirm next group
    hud.queueAskAnswer("y"); // confirmNextGroup

    const groups = [
      makeGroup("G1", [makeSlice(1)]),
      makeGroup("G2", [makeSlice(2)]),
    ];
    await uc.execute(groups);

    expect(persistence.current.lastCompletedSlice).toBe(2);
    expect(persistence.current.lastCompletedGroup).toBe("G2");

    // Agents were respawned between groups
    const tddAgents = spawner.agentsForRole("tdd");
    expect(tddAgents.length).toBe(2);
  });

  it("already-implemented detection skips verify and review", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: { skills: { plan: null, gap: null } },
      auto: true,
    });

    // TDD says "already implemented" and git SHA doesn't change (default sha-0)
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "all tests pass, already implemented" }),
    );
    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await uc.execute(groups);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    // Verify and review agents should NOT have been spawned
    expect(spawner.agentsForRole("verify").length).toBe(0);
  });

  it("direct already-implemented detection stamps completion even when no diff exists", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: { executionMode: "direct", skills: { gap: null } },
      auto: true,
    });

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "all tests pass, already implemented" }),
      okResult({ assistantText: "direct mandatory test pass complete" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("triage");

    await uc.execute([makeGroup("Direct", [makeSlice(1)])]);

    expect((persistence.current as Record<string, unknown>).executionMode).toBe("direct");
    expect((persistence.current as Record<string, unknown>).completedAt).toEqual(expect.any(String));
    expect(spawner.agentsForRole("verify")).toHaveLength(0);
    expect(spawner.agentsForRole("review")).toHaveLength(1);
    expect(spawner.lastAgent("review").sentPrompts).toHaveLength(0);
  });

  it("below review threshold skips review", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { skills: { plan: null, gap: null }, reviewThreshold: 30 },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 5, removed: 0, total: 5 }); // below threshold

    // TDD returns code
    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 1 done" }));
    spawner.onNextSpawn("review");

    // Verify: PASS
    spawner.onNextSpawn("verify",
      okResult({ assistantText: verifyJson() }),
    );

    // Completeness
    spawner.onNextSpawn("completeness",
      okResult({ assistantText: "SLICE_COMPLETE" }),
    );

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await uc.execute(groups);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // Review agent was spawned (long-lived) but never received a review prompt
    const reviewAgent = spawner.lastAgent("review");
    const reviewSends = reviewAgent.sentPrompts.filter((p) => p.includes("[REVIEW]"));
    expect(reviewSends.length).toBe(0);
  });

  it("logs the configured execution mode and direct-marked runs avoid per-slice planning logs", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: {
        executionMode: "direct",
        skills: { gap: null },
      },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 50, removed: 10, total: 60 });
    git.getDiff = vi.fn().mockResolvedValue("diff --git a/src/direct.ts b/src/direct.ts");

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "direct request implemented" }),
      okResult({ assistantText: "direct mandatory test pass complete" }),
    );
    spawner.onNextSpawn(
      "triage",
      okResult({
        assistantText: JSON.stringify({
          completeness: true,
          verify: true,
          review: true,
          gap: false,
          reason: "direct post-change triage",
        }),
      }),
    );
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: verifyJson() }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "DIRECT_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(hud.logs.map(stripAnsi)).toContain(formatExecutionModeSummary("direct"));
    expect(spawner.agentsForRole("plan")).toHaveLength(0);
    expect(spawner.agentsForRole("tdd")[0]?.sentPrompts.some((prompt) => prompt.includes("[PLAN:"))).toBe(false);
    expect(spawner.agentsForRole("tdd")[0]?.sentPrompts).toHaveLength(2);
    expect(spawner.agentsForRole("tdd")[0]?.sentPrompts[0]).toContain("[DIRECT]");
    expect(spawner.agentsForRole("tdd")[0]?.sentPrompts[1]).toContain("[DIRECT_TEST_PASS]");
    expect(spawner.agentsForRole("triage")).toHaveLength(1);
    expect(spawner.agentsForRole("completeness")).toHaveLength(1);
    expect(spawner.agentsForRole("verify")).toHaveLength(1);
    expect(spawner.agentsForRole("review")).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("Direct request");
    expect(spawner.lastAgent("verify").sentPrompts[0]).not.toContain("Slice 1");
    expect(spawner.lastAgent("completeness").sentPrompts[0]).toContain("Direct request");
    expect(spawner.lastAgent("completeness").sentPrompts[0]).not.toContain("Slice 1");
    expect((persistence.current as Record<string, unknown>).executionMode).toBe("direct");
    expect(persistence.current.currentSlice).toBeUndefined();
    expect(persistence.current.sliceTimings).toBeUndefined();
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
    expect(persistence.current.lastCompletedGroup).toBeUndefined();
    expect(persistence.current.lastSliceImplemented).toBeUndefined();
  });

  it("direct mode honors triage-driven gap-only follow-up without persisting slice or group progress", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: {
        executionMode: "direct",
        skills: { verify: null, review: null, gap: "test" },
      },
      auto: true,
    });

    git.setHasChanges(true);
    git.getDiff = vi.fn().mockResolvedValue("diff --git a/src/direct-gap.ts b/src/direct-gap.ts");

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "direct request implemented" }),
      okResult({ assistantText: "direct mandatory test pass complete" }),
    );
    spawner.onNextSpawn(
      "triage",
      okResult({
        assistantText: JSON.stringify({
          completeness: false,
          verify: false,
          review: false,
          gap: true,
          reason: "direct gap only",
        }),
      }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));

    await uc.execute([makeGroup("Direct", [makeSlice(1)])]);

    expect((persistence.current as Record<string, unknown>).executionMode).toBe("direct");
    expect(persistence.current.currentSlice).toBeUndefined();
    expect(persistence.current.sliceTimings).toBeUndefined();
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
    expect(persistence.current.lastCompletedGroup).toBeUndefined();
    expect(spawner.agentsForRole("triage")).toHaveLength(1);
    expect(spawner.agentsForRole("gap")).toHaveLength(1);
    expect(spawner.agentsForRole("verify")).toHaveLength(0);
    expect(spawner.lastAgent("gap").sentPrompts[0]).toContain("Direct request");
    expect(spawner.lastAgent("gap").sentPrompts[0]).not.toContain("group of slices");
  });

  it("direct mode runs final passes and final-fix retries against the direct request contract", async () => {
    const { uc, spawner, persistence, git, prompts } = createTestHarness({
      config: {
        executionMode: "direct",
        skills: { verify: null, review: null, gap: null },
      },
      auto: true,
    });

    git.setHasChanges(true);
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "check final state" }];

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "direct request implemented" }),
      okResult({ assistantText: "direct mandatory test pass complete" }),
      okResult({ assistantText: "fixed direct final issues" }),
    );
    spawner.onNextSpawn(
      "triage",
      okResult({
        assistantText: JSON.stringify({
          completeness: false,
          verify: false,
          review: false,
          gap: false,
          reason: "direct final path",
        }),
      }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("completeness", okResult({ assistantText: "DIRECT_COMPLETE" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "Found issue in final pass output" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "NO_ISSUES_FOUND" }));

    await uc.execute([makeGroup("Direct", [makeSlice(1)])]);

    expect((persistence.current as Record<string, unknown>).executionMode).toBe("direct");
    expect(spawner.agentsForRole("final")).toHaveLength(2);
    expect(spawner.agentsForRole("final")[0]?.sentPrompts[0]).toContain("check final state");
    expect(spawner.agentsForRole("final")[0]?.sentPrompts[0]).toContain("Direct request");
    expect(spawner.agentsForRole("final")[0]?.sentPrompts[0]).not.toContain("## Plan");
    expect(spawner.lastAgent("tdd").sentPrompts[2]).toContain("Current direct request");
    expect(spawner.lastAgent("tdd").sentPrompts[2]).not.toContain("plan content");
    expect(spawner.lastAgent("tdd").sentPrompts[2]).not.toContain("## Plan Slice");
  });
});
