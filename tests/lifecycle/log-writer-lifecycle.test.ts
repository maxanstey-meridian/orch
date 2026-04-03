import { describe, expect, it } from "vitest";
import type { Group, Slice } from "#domain/plan.js";
import { createTestHarness, okResult } from "../fakes/harness.js";

const makeSlice = (n: number, title = `Slice ${n}`): Slice => ({
  number: n,
  title,
  content: `content for slice ${n}`,
  why: `reason for slice ${n}`,
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

describe("log writer lifecycle", () => {
  it("orchestrator events are written to log writer", async () => {
    const { uc, hud, spawner, git, logWriter } = createTestHarness({
      config: { gapDisabled: true },
    });

    git.setHasChanges(true);
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan", planText: "plan" }));
    hud.queueAskAnswer("y");
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented slice 1" }),
      okResult({ assistantText: "summary done" }),
    );
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_PASS }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(logWriter.lines).toContainEqual({ badge: "ORCH", text: "Starting slice 1 (G1)" });
    expect(logWriter.lines).toContainEqual({ badge: "ORCH", text: "Completed slice 1" });
  });

  it("phase changes are written to log writer", async () => {
    const { uc, hud, spawner, git, logWriter } = createTestHarness({
      config: { gapDisabled: true },
    });

    git.setHasChanges(true);
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan", planText: "plan" }));
    hud.queueAskAnswer("y");
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented slice 1" }),
      okResult({ assistantText: "summary done" }),
    );
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_PASS }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(logWriter.lines).toContainEqual({ badge: "ORCH", text: "Entered phase tdd for slice 1" });
  });

  it("log writer is closed after execute completes", async () => {
    const { uc, hud, spawner, git, logWriter } = createTestHarness({
      config: { gapDisabled: true },
    });

    git.setHasChanges(true);
    spawner.onNextSpawn("plan", okResult({ assistantText: "plan", planText: "plan" }));
    hud.queueAskAnswer("y");
    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "implemented slice 1" }),
      okResult({ assistantText: "summary done" }),
    );
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: VERIFY_PASS }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(logWriter.closed).toBe(true);
  });

  it("agent output is tee'd to log writer", async () => {
    const { uc, spawner, logWriter } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    spawner.onNextSpawn(
      "tdd",
      (_prompt) =>
        okResult({
          assistantText: "implemented slice 1",
          streamedText: ["streamed tdd output"],
        }),
    );
    spawner.onNextSpawn("review");

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(logWriter.lines).toContainEqual({ badge: "tdd", text: "streamed tdd output" });
  });

  it("errors are written to log writer", async () => {
    const { uc, git, logWriter } = createTestHarness({
      config: { planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true },
      auto: true,
    });

    git.captureRef = async () => {
      throw new Error("capture failed");
    };

    await expect(uc.execute([makeGroup("G1", [makeSlice(1)])])).rejects.toThrow("capture failed");

    expect(logWriter.lines).toContainEqual({
      badge: "ORCH",
      text: "Execution failed: capture failed",
    });
    expect(logWriter.closed).toBe(true);
  });
});
