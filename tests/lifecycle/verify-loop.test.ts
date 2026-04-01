import { describe, it, expect } from "vitest";
import { createTestHarness, okResult } from "../fakes/harness.js";
import { IncompleteRunError } from "#domain/errors.js";
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

const VERIFY_PASS = "### VERIFY_RESULT\n**Status:** PASS\n";
const VERIFY_FAIL = "### VERIFY_RESULT\n**Status:** FAIL\n**New failures** (caused by recent changes):\n- test_foo broke\n";

describe("Verify loop lifecycle", () => {
  it("verify passes first try, slice completes normally", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, reviewSkill: null },
      auto: true,
    });

    git.setHasChanges(true);

    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_PASS }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    // No verifyFailed prompt
    const verifyPrompts = hud.askPrompts.filter((p) => p.includes("verification failed"));
    expect(verifyPrompts.length).toBe(0);
  });

  it("verify fails, TDD fixes, re-verify passes", async () => {
    const { uc, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, reviewSkill: null },
      auto: true,
    });

    git.setHasChanges(true); // TDD made changes after fix

    // TDD: implementation + fix attempt
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fixed the failing test" }),
    );
    spawner.onNextSpawn("review");

    // Verify: first FAIL, then PASS (re-verify after TDD fix)
    spawner.onNextSpawn("verify",
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_PASS }),
    );

    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);

    // TDD received a fix prompt containing the failure detail
    const tdd = spawner.lastAgent("tdd");
    // The verify loop sends the failure text to TDD as a fix instruction
    expect(tdd.sentPrompts.length).toBeGreaterThanOrEqual(2);
    // Second prompt should be a fix prompt (contains failure info)
    const fixPrompt = tdd.sentPrompts[1];
    expect(fixPrompt).toContain("test_foo");
  });

  it("verify fails, TDD makes no changes, operator chooses retry then passes", async () => {
    const { uc, hud, spawner, persistence, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, reviewSkill: null },
    });

    git.setHasChanges(true);

    // TDD: implementation + two fix attempts
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "tried to fix" }),
      okResult({ assistantText: "actually fixed it" }),
    );
    spawner.onNextSpawn("review");

    // Verify: FAIL → (TDD makes no changes, operator retries) → FAIL → (TDD fixes) → PASS
    spawner.onNextSpawn("verify",
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_FAIL }),
      okResult({ assistantText: VERIFY_PASS }),
    );

    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    // Operator: retry when verification fails with no changes
    hud.queueAskAnswer("r");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    const verifyPrompts = hud.askPrompts.filter((p) => p.includes("verification failed"));
    expect(verifyPrompts.length).toBeGreaterThanOrEqual(1);
  });

  it("verify fails, operator chooses skip, throws IncompleteRunError", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, reviewSkill: null },
    });

    // Initial hasChanges=true (so runSlice doesn't skip), but after TDD fix attempt → false (no real changes)
    git.queueHasChanges(true); // completenessCheck: hasChanges check
    git.setHasChanges(false);  // verify loop: TDD made no changes → gate fires

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "tried to fix" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_FAIL }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    // Operator: skip
    hud.queueAskAnswer("s");

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(IncompleteRunError);
  });

  it("verify fails, operator chooses stop, throws IncompleteRunError", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { planDisabled: true, gapDisabled: true, reviewSkill: null },
    });

    git.queueHasChanges(true); // completenessCheck
    git.setHasChanges(false);  // verify loop: TDD made no changes → gate fires

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "tried to fix" }),
    );
    spawner.onNextSpawn("review");
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_FAIL }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    // Operator: stop
    hud.queueAskAnswer("t");

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow(IncompleteRunError);
  });
});
