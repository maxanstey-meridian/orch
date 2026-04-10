import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "#domain/config.js";
import { FULL_TRIAGE } from "#domain/triage.js";
import { AgentExecutionUnitTriager } from "#infrastructure/triage/agent-execution-unit-triager.js";
import { FakeAgentSpawner } from "../../fakes/fake-agent-spawner.js";

const createConfig = (): OrchestratorConfig => ({
  cwd: "/tmp/orch",
  planPath: "/tmp/plan.json",
  planContent: "plan",
  brief: "brief",
  executionMode: "sliced",
  executionPreference: "auto",
  auto: false,
  reviewThreshold: 30,
  maxReviewCycles: 2,
  stateFile: "/tmp/state.json",
  logPath: null,
  tier: "medium",
  skills: {
    tdd: null,
    review: null,
    verify: null,
    plan: null,
    gap: null,
    completeness: null,
  },
  maxReplans: 1,
  defaultProvider: "claude",
  agentConfig: {
    tdd: { provider: "claude", model: "sonnet" },
    review: { provider: "claude", model: "sonnet" },
    verify: { provider: "claude", model: "sonnet" },
    plan: { provider: "claude", model: "sonnet" },
    gap: { provider: "claude", model: "sonnet" },
    final: { provider: "claude", model: "sonnet" },
    completeness: { provider: "claude", model: "sonnet" },
    triage: { provider: "claude", model: "sonnet" },
  },
});

const triageInput = {
  mode: "sliced" as const,
  unitKind: "slice" as const,
  diff: "diff --git a/src/foo.ts b/src/foo.ts\n+const changed = true;",
  diffStats: { added: 1, removed: 0, total: 1 },
  reviewThreshold: 30,
  finalBoundary: false,
  moreUnitsInGroup: true,
  pending: {
    verify: false,
    completeness: false,
    review: false,
    gap: false,
  },
};

describe("AgentExecutionUnitTriager", () => {
  it("returns skip decisions for an empty diff", async () => {
    const triager = new AgentExecutionUnitTriager(new FakeAgentSpawner(), createConfig());

    await expect(triager.decide({ ...triageInput, diff: "   " })).resolves.toEqual({
      completeness: "skip",
      verify: "skip",
      review: "skip",
      gap: "skip",
      reason: "empty diff",
    });
  });

  it("spawns a triage agent, prefers assistantText, parses the result, and kills the agent", async () => {
    const spawner = new FakeAgentSpawner();
    spawner.onNextSpawn("triage", {
      exitCode: 0,
      assistantText: '{"completeness":"skip","verify":"run_now","review":"defer","gap":"skip","reason":"targeted"}',
      resultText: '{"completeness":"run_now","verify":"run_now","review":"run_now","gap":"run_now","reason":"ignored"}',
      needsInput: false,
      sessionId: "triage-session",
    });
    const triager = new AgentExecutionUnitTriager(spawner, createConfig());

    await expect(triager.decide(triageInput)).resolves.toEqual({
      completeness: "skip",
      verify: "run_now",
      review: "defer",
      gap: "skip",
      reason: "targeted",
    });

    const spawned = spawner.lastAgent("triage");
    expect(spawner.spawned[0]?.opts?.cwd).toBe("/tmp/orch");
    expect(spawned.sentPrompts[0]).toContain(triageInput.diff);
    expect(spawned.alive).toBe(false);
  });

  it("falls back to resultText when assistantText is empty", async () => {
    const spawner = new FakeAgentSpawner();
    spawner.onNextSpawn("triage", {
      exitCode: 0,
      assistantText: "   ",
      resultText: '{"completeness":"run_now","verify":"skip","review":"skip","gap":"defer","reason":"fallback text"}',
      needsInput: false,
      sessionId: "triage-session",
    });
    const triager = new AgentExecutionUnitTriager(spawner, createConfig());

    await expect(triager.decide(triageInput)).resolves.toEqual({
      completeness: "run_now",
      verify: "skip",
      review: "skip",
      gap: "defer",
      reason: "fallback text",
    });
  });

  it("falls back to FULL_TRIAGE when the agent call fails", async () => {
    const spawner = new FakeAgentSpawner();
    spawner.onNextSpawn("triage", () => {
      throw new Error("boom");
    });
    const triager = new AgentExecutionUnitTriager(spawner, createConfig());

    await expect(triager.decide(triageInput)).resolves.toEqual(FULL_TRIAGE);
    expect(spawner.lastAgent("triage").alive).toBe(false);
  });
});
