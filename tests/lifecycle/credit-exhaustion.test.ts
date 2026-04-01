import { describe, it, expect } from "vitest";
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

  it("non-retryable error, operator retries, second attempt succeeds", async () => {
    const { uc, hud, spawner, persistence } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    // TDD: first returns credit error, second succeeds
    // Use queueResponse on the handle after spawn since we need dynamic behavior
    spawner.onNextSpawn("tdd",
      okResult({ exitCode: 1, resultText: "usage limit exceeded", assistantText: "" }),
      okResult({ assistantText: "implemented successfully" }),
    );
    spawner.onNextSpawn("review");

    // HUD: operator chooses retry
    hud.queueAskAnswer("r");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
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
