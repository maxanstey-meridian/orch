import { describe, it, expect } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
import type { Group, Slice } from "#domain/plan.js";

const makeSlice = (number: number, content = `content for slice ${number}`): Slice => ({
  number,
  title: `Slice ${number}`,
  content,
  why: `reason ${number}`,
  files: [{ path: `src/s${number}.ts`, action: "edit" }],
  details: `details ${number}`,
  tests: `tests ${number}`,
});

const makeGroup = (name: string, slices: readonly Slice[]): Group => ({
  name,
  slices: [...slices],
});

describe("Execution-unit tier selection", () => {
  it("selects tier before each slice and uses that tier for plan and builder prompts", async () => {
    const { uc, spawner, persistence, tierSelector, triager, rolePromptResolver } =
      createTestHarness({
        config: { skills: { gap: null, verify: null, review: null } },
        auto: true,
      });

    rolePromptResolver.setPrompt("tdd:medium", "tdd medium");
    rolePromptResolver.setPrompt("tdd:small", "tdd small");
    rolePromptResolver.setPrompt("tdd:large", "tdd large");
    rolePromptResolver.setPrompt("review:medium", "review medium");
    rolePromptResolver.setPrompt("review:small", "review small");
    rolePromptResolver.setPrompt("review:large", "review large");
    rolePromptResolver.setPrompt("plan:small", "plan small");
    rolePromptResolver.setPrompt("plan:large", "plan large");

    tierSelector.queueResult(
      { tier: "small", reason: "slice 1 is small" },
      { tier: "large", reason: "slice 2 is large" },
    );
    triager.queueResult(
      { completeness: "skip", verify: "skip", review: "skip", gap: "defer", reason: "slice 1 boundary" },
      { completeness: "skip", verify: "skip", review: "skip", gap: "defer", reason: "slice 2 boundary" },
    );

    spawner.onNextSpawn("plan", okResult({ assistantText: "plan 1", planText: "plan 1" }));
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan 2", planText: "plan 2" }));
    spawner.onNextSpawn("tdd");
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented 1" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented 2" }));
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])]);

    expect(tierSelector.inputs).toEqual([
      { mode: "sliced", unitKind: "slice", content: "content for slice 1" },
      { mode: "sliced", unitKind: "slice", content: "content for slice 2" },
    ]);

    const tddSpawns = spawner.spawned.filter((spawn) => spawn.role === "tdd");
    expect(tddSpawns.map((spawn) => spawn.opts?.systemPrompt)).toEqual([
      "tdd medium",
      "tdd small",
      "tdd large",
    ]);

    const reviewSpawns = spawner.spawned.filter((spawn) => spawn.role === "review");
    expect(reviewSpawns.map((spawn) => spawn.opts?.systemPrompt)).toEqual([
      "review medium",
      "review small",
      "review large",
    ]);

    const planSpawns = spawner.spawned.filter((spawn) => spawn.role === "plan");
    expect(planSpawns.map((spawn) => spawn.opts?.systemPrompt)).toEqual([
      "plan small",
      "plan large",
    ]);

    expect(persistence.current.activeTier).toBe("large");
  });

  it("keeps the persisted tier when resuming an in-flight slice", async () => {
    const { uc, spawner, tierSelector, triager, rolePromptResolver } = createTestHarness({
      config: { skills: { gap: null, verify: null, review: null } },
      auto: true,
      state: {
        executionMode: "sliced",
        activeTier: "small",
        tier: "small",
        currentPhase: "tdd",
        currentSlice: 2,
        currentGroup: "G1",
        lastCompletedSlice: 1,
      },
    });

    rolePromptResolver.setPrompt("plan:small", "plan small");

    triager.queueResult({
      completeness: "skip",
      verify: "skip",
      review: "skip",
      gap: "defer",
      reason: "resume boundary",
    });

    spawner.onNextSpawn("plan", okResult({ assistantText: "plan 2", planText: "plan 2" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented 2" }));
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1), makeSlice(2)])]);

    expect(tierSelector.inputs).toEqual([]);

    const planSpawn = spawner.spawned.find((spawn) => spawn.role === "plan");
    expect(planSpawn?.opts?.systemPrompt).toBe("plan small");
  });
});
