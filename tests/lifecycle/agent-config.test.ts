import { describe, it, expect } from "vitest";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import { createTestHarness, okResult } from "../fakes/harness.js";
import type { Group, Slice } from "#domain/plan.js";

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

describe("Agent config lifecycle", () => {
  it("orchestration completes with per-role agent config overrides", async () => {
    const { uc, spawner, persistence } = createTestHarness({
      config: {
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        agentConfig: {
          ...AGENT_DEFAULTS,
          tdd: { provider: "claude", model: "claude-sonnet-4-20250514" },
          review: { provider: "claude", model: "claude-opus-4-20250514" },
        },
      },
      auto: true,
    });

    spawner.onNextSpawn("tdd",
      okResult({ assistantText: "slice 1 done" }),
    );

    const groups = [makeGroup("G1", [makeSlice(1)])];
    await uc.execute(groups);

    expect(persistence.current.lastCompletedSlice).toBe(1);
    expect(spawner.agentsForRole("tdd")).toHaveLength(1);
  });
});
