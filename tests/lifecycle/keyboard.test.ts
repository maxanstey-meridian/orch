import { describe, it, expect } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
// import type { Group, Slice } from "#domain/plan.js";
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

describe("Keyboard shortcuts", () => {
  it("pressing S toggles skipping on, pressing S again toggles it off", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    // TDD: during send, press S twice (on then off)
    spawner.onNextSpawn("tdd", (prompt) => {
      hud.simulateKey("s"); // skip on
      hud.simulateKey("s"); // skip off
      return okResult({ assistantText: "done" });
    });
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    // HUD should have seen: setSkipping(true), then setSkipping(false)
    // i.e. "S: skipping..." appears then reverts to "S: skip"
    expect(hud.skippingHistory).toEqual([true, false]);
    // Slice should have completed normally (skip was cancelled)
    expect(uc.sliceSkipFlag).toBe(false);
    expect(hud.skippingHistory[hud.skippingHistory.length - 1]).toBe(false);
  });

  it("pressing Q stops orchestration gracefully", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    // TDD: during slice 1 send, press Q
    spawner.onNextSpawn("tdd", (prompt) => {
      hud.simulateKey("q");
      return okResult({ assistantText: "done" });
    });
    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1), makeSlice(2)])];
    await uc.execute(groups);

    // Quit was requested
    expect(uc.quitRequested).toBe(true);
    // Slice 2 should NOT have been processed
    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts.length).toBe(1); // only slice 1
  });
});
