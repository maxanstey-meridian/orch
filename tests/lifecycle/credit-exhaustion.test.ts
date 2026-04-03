import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
import { CreditExhaustedError } from "#domain/errors.js";
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

describe("Credit exhaustion lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("non-retryable error, operator quits via HUD", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
    });

    // TDD returns a credit-exhausted result
    spawner.onNextSpawn("tdd",
      okResult({
        exitCode: 1,
        resultText: "usage limit exceeded for this billing period",
        assistantText: "",
      }),
    );
    spawner.onNextSpawn("review");

    // HUD: operator chooses quit
    hud.queueAskAnswer("q");

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(CreditExhaustedError);

    // State was saved before the gate
    expect(persistence.saveHistory.length).toBeGreaterThan(0);

    // HUD was asked about credit exhaustion
    const creditPrompt = hud.askPrompts.find((p) =>
      p.toLowerCase().includes("credit") || p.toLowerCase().includes("usage limit"),
    );
    expect(creditPrompt).toBeDefined();
  });

  it("treats assistantText-only usage-limit warnings as terminal credit exhaustion", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
    });

    spawner.onNextSpawn("tdd",
      okResult({
        exitCode: 1,
        assistantText: "You've hit your limit · resets 10am (Europe/London)",
        resultText: "",
      }),
    );
    spawner.onNextSpawn("review");

    hud.queueAskAnswer("q");

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(CreditExhaustedError);

    const creditPrompt = hud.askPrompts.find((p) => p.toLowerCase().includes("credit exhaustion"));
    expect(creditPrompt).toBeDefined();
  });

  it("auto mode probes until usage is available again when credit exhaustion is detected", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });
    vi.useFakeTimers();
    uc.usageProbeDelayMs = 1_000;
    uc.usageProbeMaxDelayMs = 2_000;

    spawner.onNextSpawn("tdd",
      okResult({
        exitCode: 1,
        resultText: "You've hit your limit · resets 10am (Europe/London)",
        assistantText: "",
      }),
      okResult({ assistantText: "implemented successfully" }),
    );
    spawner.onNextSpawn("tdd",
      okResult({
        exitCode: 1,
        resultText: "You've hit your limit · resets 10am (Europe/London)",
        assistantText: "",
      }),
    );
    spawner.onNextSpawn("tdd", okResult({ assistantText: "OK" }));
    spawner.onNextSpawn("review");

    const run = uc.execute([makeGroup("G1", [makeSlice(1)])]);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(hud.askPrompts).toHaveLength(0);
  });

  it("retryable overloaded error auto-retries without operator prompt", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    // TDD: first returns 529 overloaded, second succeeds
    spawner.onNextSpawn("tdd",
      okResult({ exitCode: 1, resultText: "529 overloaded", assistantText: "" }),
      okResult({ assistantText: "done" }),
    );
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // No askUser call for retryable errors
    const creditPrompts = hud.askPrompts.filter((p) =>
      p.toLowerCase().includes("credit") || p.toLowerCase().includes("retry"),
    );
    expect(creditPrompts.length).toBe(0);
  });
});
