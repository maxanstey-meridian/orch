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

describe("Replan lifecycle", () => {
  it("operator rejects plan, new plan generated, then accepted", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { gapDisabled: true, verifySkill: null, reviewSkill: null },
    });

    // Two plan agents will be spawned (one per plan attempt)
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan v1", planText: "plan v1" }));
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan v2", planText: "plan v2" }));

    // Gate: reject first, accept second
    hud.queueAskAnswer("r"); // reject plan v1
    hud.queueAskAnswer("y"); // accept plan v2

    // TDD executes the accepted plan
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // Two plan agents were spawned
    expect(spawner.agentsForRole("plan").length).toBe(2);

    // TDD received exactly one execute prompt (not two)
    const tdd = spawner.lastAgent("tdd");
    const execPrompts = tdd.sentPrompts.filter((p) => p.includes("[EXEC:"));
    expect(execPrompts.length).toBe(1);
  });

  it("max replans reached, plan is force-accepted", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { gapDisabled: true, verifySkill: null, reviewSkill: null, maxReplans: 2 },
    });

    // Plan agents for each attempt
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan v1", planText: "v1" }));
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan v2", planText: "v2" }));
    // Force-accept spawns another plan agent
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan v3", planText: "v3" }));

    // Reject twice (hit maxReplans), then force-accept skips the gate
    hud.queueAskAnswer("r"); // reject v1
    hud.queueAskAnswer("r"); // reject v2
    // No third answer needed — force-accept bypasses gate

    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // Gate was asked exactly 2 times (not 3)
    const planPrompts = hud.askPrompts.filter((p) => p.includes("Accept plan"));
    expect(planPrompts.length).toBe(2);
  });

  it("operator edits plan with guidance, guidance reaches TDD execute", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { gapDisabled: true, verifySkill: null, reviewSkill: null },
    });

    spawner.onNextSpawn("plan", okResult({ assistantText: "plan", planText: "the plan" }));

    // Gate: edit with guidance (two askUser calls: first "e" for edit, then the guidance)
    hud.queueAskAnswer("e");
    hud.queueAskAnswer("add error handling for edge cases");

    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented with error handling" }));
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // TDD execute prompt should contain the operator guidance
    const tdd = spawner.lastAgent("tdd");
    const execPrompt = tdd.sentPrompts.find((p) => p.includes("[EXEC:"));
    expect(execPrompt).toBeDefined();
    expect(execPrompt).toContain("add error handling for edge cases");
  });
});
