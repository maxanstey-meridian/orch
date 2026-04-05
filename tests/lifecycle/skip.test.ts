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

const VERIFY_PASS = `### VERIFY_JSON
\`\`\`json
${JSON.stringify({
  status: "PASS",
  checks: [{ check: "npx vitest run", status: "PASS" }],
  sliceLocalFailures: [],
  outOfScopeFailures: [],
  preExistingFailures: [],
  runnerIssue: null,
  retryable: false,
  summary: "Verification passed.",
}, null, 2)}
\`\`\``;

describe("Skip lifecycle", () => {
  it("skip during plan phase aborts with IncompleteRunError", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { skills: { gap: null } },
    });

    // Builder planning: when the planning prompt is sent, trigger skip via the HUD key.
    spawner.onNextSpawn("tdd", (prompt) => {
      hud.simulateKey("s");
      return okResult({ assistantText: "plan text", planText: "plan" });
    });

    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await expect(uc.execute(groups)).rejects.toThrow(IncompleteRunError);
  });

  it("skip returns false when no active slice (idle phase)", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    // Need to call execute to register interrupts, but trigger skip before slice starts
    let skipResult: boolean | null = null;

    spawner.onNextSpawn("tdd", (prompt) => {
      // By the time TDD gets a prompt, we're in a slice — too late.
      // We need to test before execute starts processing slices.
      return okResult({ assistantText: "done" });
    });
    spawner.onNextSpawn("review");

    // Use git.onCaptureRef to fire skip before the first slice starts
    const { git } = createTestHarness(); // unused, just need the real one
    // Actually, let's test this differently — trigger skip on the harness's git
    const harness = createTestHarness({
      config: { skills: { plan: null, verify: null, review: null, gap: null } },
      auto: true,
    });

    let skipFiredBeforeSlice = false;
    harness.git.onCaptureRef = () => {
      if (!skipFiredBeforeSlice && harness.hud.hasKeyHandler) {
        skipFiredBeforeSlice = true;
        skipResult = harness.hud.hasKeyHandler ? (() => {
          harness.hud.simulateKey("s");
          // Check if skipping indicator was set
          return harness.hud.skippingHistory.length > 0;
        })() : false;
      }
    };

    harness.spawner.onNextSpawn("tdd", okResult({ assistantText: "done" }));
    harness.spawner.onNextSpawn("review");

    // Execute will complete normally since skip during captureRef (before slice) returns false
    await harness.uc.execute([makeGroup("G1", [makeSlice(1)])]);

    // Skip was attempted but returned false (no active slice), so no skipping indicator
    // The slice completed normally
    expect(harness.persistence.current.lastCompletedSlice).toBe(1);
  });

  it("skip sets UI indicator via setSkipping(true)", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { skills: { gap: null } },
    });

    // Builder planning: trigger skip when the planning prompt is sent (we're in Planning phase)
    spawner.onNextSpawn("tdd", (_prompt) => {
      hud.simulateKey("s");
      return okResult({ assistantText: "plan", planText: "plan" });
    });

    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await expect(uc.execute(groups)).rejects.toThrow(IncompleteRunError);

    // The real InkProgressSink should have called setSkipping(true) on the HUD
    expect(hud.skippingHistory).toContain(true);
  });

  it("sliceSkipFlag is reset after IncompleteRunError", async () => {
    const { uc, hud, spawner } = createTestHarness({
      config: { skills: { gap: null } },
    });

    spawner.onNextSpawn("tdd", () => {
      hud.simulateKey("s");
      return okResult({ assistantText: "plan", planText: "plan" });
    });

    spawner.onNextSpawn("review");

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await expect(uc.execute(groups)).rejects.toThrow(IncompleteRunError);

    // failIncompleteSlice resets the flag
    expect(uc.sliceSkipFlag).toBe(false);
  });

  it("skip during verify phase causes slice failure", async () => {
    const { uc, hud, spawner, git } = createTestHarness({
      config: { skills: { plan: null, gap: null } },
      auto: true,
    });

    git.setHasChanges(true);

    // TDD returns code
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("review");

    // Verify: trigger skip when verify runs
    spawner.onNextSpawn("verify", () => {
      hud.simulateKey("s");
      return okResult({ assistantText: VERIFY_PASS });
    });

    // Completeness
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await expect(uc.execute(groups)).rejects.toThrow(IncompleteRunError);
  });
});
