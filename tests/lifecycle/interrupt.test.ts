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

describe("Interrupt lifecycle", () => {
  it("guide injects text into TDD agent through full chain", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    // TDD: when send arrives, simulate guide keypress
    spawner.onNextSpawn("tdd", (prompt) => {
      // Simulate: press G → startPrompt("guide") → submit guidance text
      hud.simulateKey("g");
      hud.simulateInterruptSubmit("focus on edge cases", "guide");
      return okResult({ assistantText: "done" });
    });
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    // Guide text should have been injected into the TDD agent
    const tdd = spawner.lastAgent("tdd");
    expect(tdd.injectedMessages.some((m) => m.includes("focus on edge cases"))).toBe(true);

    // startPrompt was called with "guide"
    expect(hud.promptsStarted).toContain("guide");
  });

  it("hard interrupt kills TDD, respawns, sends guidance", async () => {
    const { uc, hud, spawner } = createTestHarness({
      // Plan ENABLED so the interrupt check in planThenExecute fires
      config: { skills: { gap: null, verify: null, review: null } },
    });

    // Plan agent: returns plan, hud accepts
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan", planText: "the plan" }));
    hud.queueAskAnswer("y"); // accept plan

    // First TDD: during execute prompt, trigger hard interrupt
    spawner.onNextSpawn("tdd", (prompt) => {
      if (prompt.includes("[EXEC:")) {
        hud.simulateKey("i");
        hud.simulateInterruptSubmit("use factory pattern instead", "interrupt");
      }
      return okResult({ assistantText: "done" });
    });

    // Dead-session fallback now detects hardInterrupt and returns it directly.
    // Main loop (line 220) respawns TDD and sends guidance.
    spawner.onNextSpawn("tdd", okResult({ assistantText: "reimplemented with factory" }));

    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    // First TDD was killed by the interrupt
    const allTdd = spawner.agentsForRole("tdd");
    expect(allTdd[0].alive).toBe(false);

    const lastTdd = allTdd[allTdd.length - 1];
    expect(lastTdd.sentPrompts.some((p) => p.includes("use factory pattern instead"))).toBe(true);

    // Interrupt prompt was started
    expect(hud.promptsStarted).toContain("interrupt");
  });

  it("hardInterruptPending is cleared after being consumed", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { skills: { gap: null, verify: null, review: null } },
    });

    // Plan: trigger interrupt during plan phase (checked at line 327-337)
    spawner.onNextSpawn("plan", () => {
      hud.simulateKey("i");
      hud.simulateInterruptSubmit("rethink this", "interrupt");
      return okResult({ assistantText: "plan", planText: "plan" });
    });

    // First TDD (will be killed by interrupt)
    spawner.onNextSpawn("tdd");

    // Respawned TDD after interrupt
    spawner.onNextSpawn("tdd", okResult({ assistantText: "done after rethink" }));

    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(uc.hardInterruptPending).toBeNull();
  });
});
