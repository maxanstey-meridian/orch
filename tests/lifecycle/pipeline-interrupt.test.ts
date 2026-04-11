import { describe, expect, it } from "vitest";
import { IncompleteRunError } from "#domain/errors.js";
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

describe("pipeline interrupts", () => {
  it("fails the current slice when skip is requested mid-execution", async () => {
    const harness = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    harness.spawner.onNextSpawn("tdd", () => {
      harness.hud.simulateKey("s");
      return okResult({ assistantText: "implemented" });
    });

    await expect(
      harness.execute([makeGroup("Core", [makeSlice(1)])]),
    ).rejects.toThrow(IncompleteRunError);

    expect(harness.hud.skippingHistory).toContain(true);
    expect(harness.persistence.saveHistory.some((state) => state.lastCompletedSlice === 1)).toBe(false);
  });

  it("stops after the current slice when quit is requested", async () => {
    const harness = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    harness.spawner.onNextSpawn("tdd", () => {
      harness.hud.simulateKey("q");
      return okResult({ assistantText: "implemented" });
    });

    await harness.execute([makeGroup("Core", [makeSlice(1), makeSlice(2)])]);

    expect(harness.uc.quitRequested).toBe(true);
    expect(harness.spawner.lastAgent("tdd").sentPrompts).toHaveLength(1);
    expect(harness.persistence.current.lastCompletedSlice).toBeUndefined();
  });

  it("kills and respawns tdd when a hard interrupt is submitted", async () => {
    const harness = createTestHarness({
      config: { skills: { gap: null, verify: null, review: null } },
      auto: true,
    });

    harness.spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "plan", planText: "plan" }),
      () => {
        harness.hud.simulateKey("i");
        harness.hud.simulateInterruptSubmit("use factory pattern instead", "interrupt");
        return okResult({ assistantText: "implemented" });
      },
    );
    harness.spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "reimplemented with factory" }),
    );

    await harness.execute([makeGroup("Core", [makeSlice(1)])]);

    const allTdd = harness.spawner.agentsForRole("tdd");
    expect(allTdd[0].alive).toBe(false);
    expect(allTdd[allTdd.length - 1].sentPrompts.some((prompt) =>
      prompt.includes("use factory pattern instead"),
    )).toBe(true);
    expect(harness.uc.hardInterruptPending).toBeNull();
  });
});
