import { describe, it, expect } from "vitest";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
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

describe("Crash recovery lifecycle", () => {
  it("direct mode clears stale slice progress instead of pretending the run is slice-resumable", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: {
        executionMode: "direct",
        planDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        gapDisabled: true,
      },
      state: {
        executionMode: "sliced",
        currentSlice: 2,
        currentGroup: "Legacy",
        lastCompletedSlice: 2,
        lastCompletedGroup: "Legacy",
        sliceTimings: [
          {
            number: 2,
            startedAt: "2026-04-03T09:00:00.000Z",
            completedAt: "2026-04-03T09:10:00.000Z",
          },
        ],
      },
      auto: true,
    });

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented direct request" }),
      okResult({ assistantText: "mandatory test pass complete" }),
    );
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("Direct", [makeSlice(1)])]);

    expect(persistence.current.executionMode).toBe("direct");
    expect(persistence.current.currentSlice).toBeUndefined();
    expect(persistence.current.currentGroup).toBeUndefined();
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
    expect(persistence.current.lastCompletedGroup).toBeUndefined();
    expect(persistence.current.sliceTimings).toBeUndefined();
    expect(persistence.current.completedAt).toEqual(expect.any(String));
  });

  it("resumes from persisted state, skips completed slices", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      state: {
        lastCompletedSlice: 2,
        tddSession: { provider: "claude", id: "old-tdd-session" },
        reviewSession: { provider: "claude", id: "old-review-session" },
      },
      auto: true,
    });

    // TDD: only slice 3 should be processed
    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 3 done" }));
    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1), makeSlice(2), makeSlice(3)])];
    await uc.execute(groups);

    expect(persistence.current.lastCompletedSlice).toBe(3);
    expect(persistence.current.currentSlice).toBe(3);
    expect(persistence.current.currentGroup).toBe("G1");
    expect(persistence.current.sliceTimings).toEqual([
      {
        number: 3,
        startedAt: expect.any(String),
        completedAt: expect.any(String),
      },
    ]);

    // TDD received only 1 prompt (slice 3, not 1 or 2)
    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts.length).toBe(1);

    // Agents were spawned with resume session IDs
    const tddSpawn = spawner.spawned.find((s) => s.role === "tdd");
    expect(tddSpawn?.opts?.resumeSessionId).toBe("old-tdd-session");

    const reviewSpawn = spawner.spawned.find((s) => s.role === "review");
    expect(reviewSpawn?.opts?.resumeSessionId).toBe("old-review-session");
  });

  it("drops persisted sessions when they belong to a different provider", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: {
        planDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        gapDisabled: true,
        defaultProvider: "codex",
        agentConfig: {
          ...AGENT_DEFAULTS,
          tdd: { provider: "codex" },
          review: { provider: "codex" },
        },
      },
      state: {
        lastCompletedSlice: 2,
        tddSession: { provider: "claude", id: "old-tdd-session" },
        reviewSession: { provider: "claude", id: "old-review-session" },
      },
      auto: true,
    });

    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 3 done" }));
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2), makeSlice(3)])]);

    const tddSpawn = spawner.spawned.find((s) => s.role === "tdd");
    const reviewSpawn = spawner.spawned.find((s) => s.role === "review");
    expect(tddSpawn?.opts?.resumeSessionId).toBeUndefined();
    expect(reviewSpawn?.opts?.resumeSessionId).toBeUndefined();
    expect(persistence.current.tddSession).toEqual({ provider: "codex", id: expect.any(String) });
    expect(persistence.current.reviewSession).toEqual({ provider: "codex", id: expect.any(String) });
  });

  it("state persisted incrementally after each slice", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "slice 1" }),
      okResult({ assistantText: "slice 2" }),
      okResult({ assistantText: "slice 3" }),
    );
    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1), makeSlice(2), makeSlice(3)])];
    await uc.execute(groups);

    // State was saved multiple times with incrementing lastCompletedSlice
    const completedSlices = persistence.saveHistory
      .map((s) => s.lastCompletedSlice)
      .filter((n) => n !== undefined);

    expect(completedSlices).toContain(1);
    expect(completedSlices).toContain(2);
    expect(completedSlices).toContain(3);
  });

  it("fresh instance from saved state resumes correctly", async () => {
    // Run 1: execute only slice 1
    const run1 = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    run1.spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 1 done" }));
    run1.spawner.onNextSpawn("review");

    await run1.uc.execute([makeGroup("G1", [makeSlice(1)])]);
    expect(run1.persistence.current.lastCompletedSlice).toBe(1);

    // Run 2: fresh instance with run 1's saved state, full group (slices 1+2)
    const run2 = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      state: run1.persistence.current,
      auto: true,
    });

    run2.spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 2 done" }));
    run2.spawner.onNextSpawn("review");

    await run2.uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])]);

    // Run 2 skipped slice 1 (from state) and only processed slice 2
    expect(run2.persistence.current.lastCompletedSlice).toBe(2);
    const tdd = run2.spawner.lastAgent("tdd");
    expect(tdd.sentPrompts.length).toBe(1); // only slice 2
  });

  it("resumes and persists sessions using each role's configured provider", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: {
        planDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        gapDisabled: true,
        defaultProvider: "claude",
        agentConfig: {
          ...AGENT_DEFAULTS,
          tdd: { provider: "codex" },
          review: { provider: "claude" },
        },
      },
      state: {
        tddSession: { provider: "codex", id: "old-tdd-session" },
        reviewSession: { provider: "claude", id: "old-review-session" },
      },
      auto: true,
    });

    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 1 done" }));
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    const tddSpawn = spawner.spawned.find((spawn) => spawn.role === "tdd");
    const reviewSpawn = spawner.spawned.find((spawn) => spawn.role === "review");
    expect(tddSpawn?.opts?.resumeSessionId).toBe("old-tdd-session");
    expect(reviewSpawn?.opts?.resumeSessionId).toBe("old-review-session");
    expect(persistence.current.tddSession).toEqual({ provider: "codex", id: expect.any(String) });
    expect(persistence.current.reviewSession).toEqual({
      provider: "claude",
      id: expect.any(String),
    });
  });

  it("grouped mode does not treat lastCompletedSlice alone as a completed group boundary", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: {
        executionMode: "grouped",
        planDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        gapDisabled: true,
      },
      state: {
        lastCompletedSlice: 2,
      },
      auto: true,
    });

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "group rebuilt" }),
      okResult({ assistantText: "group mandatory test pass" }),
    );
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("Core", [makeSlice(1), makeSlice(2)])]);

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts[0]).toContain("[GROUP_EXEC:Core]");
    expect(persistence.current.lastCompletedGroup).toBe("Core");
  });

  it("grouped mode resumes from the last completed group boundary instead of replaying it", async () => {
    const { uc, spawner } = createTestHarness({
      config: {
        executionMode: "grouped",
        planDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        gapDisabled: true,
      },
      state: {
        lastCompletedSlice: 2,
        lastCompletedGroup: "Core",
      },
      auto: true,
    });

    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "next group rebuilt" }),
      okResult({ assistantText: "next group mandatory test pass" }),
    );
    spawner.onNextSpawn("review");

    await uc.execute([
      makeGroup("Core", [makeSlice(1), makeSlice(2)]),
      makeGroup("API", [makeSlice(3)]),
    ]);

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts).toHaveLength(2);
    expect(tdd.sentPrompts[0]).toContain("[GROUP_EXEC:API]");
    expect(tdd.sentPrompts[0]).not.toContain("[GROUP_EXEC:Core]");
  });
});
