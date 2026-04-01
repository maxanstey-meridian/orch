import { describe, it, expect } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
import type { Group, Slice } from "#domain/plan.js";

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

describe("Happy path lifecycle", () => {
  it("single slice completes through plan-execute-verify-review", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: { gapDisabled: true },
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
      okResult({ assistantText: "### VERIFY_RESULT\n**Status:** PASS\n" }),
    );

    // Completeness agent: returns complete
    spawner.onNextSpawn("completeness",
      okResult({ assistantText: "SLICE_COMPLETE" }),
    );

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await uc.execute(groups);

    // State advanced
    expect(persistence.current.lastCompletedSlice).toBe(1);

    // Agents were spawned for the right roles
    expect(spawner.agentsForRole("plan").length).toBeGreaterThanOrEqual(1);
    expect(spawner.agentsForRole("tdd").length).toBe(1);
    expect(spawner.agentsForRole("verify").length).toBe(1);
    expect(spawner.agentsForRole("review").length).toBe(1);
  });

  it("two slices in one group both complete with plan disabled", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
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

  it("two groups with inter-group confirmation and agent respawn", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
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
      config: { planDisabled: true, gapDisabled: true },
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

  it("below review threshold skips review", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, reviewThreshold: 30 },
      auto: true,
    });

    git.setHasChanges(true);
    git.setDiffStats({ added: 5, removed: 0, total: 5 }); // below threshold

    // TDD returns code
    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 1 done" }));
    spawner.onNextSpawn("review");

    // Verify: PASS
    spawner.onNextSpawn("verify",
      okResult({ assistantText: "### VERIFY_RESULT\n**Status:** PASS\n" }),
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
});
