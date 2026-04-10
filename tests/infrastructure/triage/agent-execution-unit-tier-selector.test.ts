import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "#domain/config.js";
import { COMPLEXITY_TRIAGE_FALLBACK } from "#domain/triage.js";
import { AgentExecutionUnitTierSelector } from "#infrastructure/triage/agent-execution-unit-tier-selector.js";
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

const tierInput = {
  mode: "sliced" as const,
  unitKind: "slice" as const,
  content: "Implement prompt builder support for grouped and direct execution.",
};

describe("AgentExecutionUnitTierSelector", () => {
  it("returns the empty-content fallback with a unit-specific reason", async () => {
    const selector = new AgentExecutionUnitTierSelector(new FakeAgentSpawner(), createConfig());

    await expect(selector.select({ ...tierInput, content: "   " })).resolves.toEqual({
      ...COMPLEXITY_TRIAGE_FALLBACK,
      reason: `${COMPLEXITY_TRIAGE_FALLBACK.reason}: empty slice content`,
    });
  });

  it("spawns a triage agent, prefers assistantText, parses the result, and kills the agent", async () => {
    const spawner = new FakeAgentSpawner();
    spawner.onNextSpawn("triage", {
      exitCode: 0,
      assistantText: '{"tier":"large","reason":"broad surface"}',
      resultText: '{"tier":"small","reason":"ignored"}',
      needsInput: false,
      sessionId: "triage-session",
    });
    const selector = new AgentExecutionUnitTierSelector(spawner, createConfig());

    await expect(selector.select(tierInput)).resolves.toEqual({
      tier: "large",
      reason: "broad surface",
    });

    const spawned = spawner.lastAgent("triage");
    expect(spawner.spawned[0]?.opts?.cwd).toBe("/tmp/orch");
    expect(spawned.sentPrompts[0]).toContain(tierInput.content);
    expect(spawned.alive).toBe(false);
  });

  it("falls back to resultText when assistantText is empty", async () => {
    const spawner = new FakeAgentSpawner();
    spawner.onNextSpawn("triage", {
      exitCode: 0,
      assistantText: "",
      resultText: '{"tier":"small","reason":"result text fallback"}',
      needsInput: false,
      sessionId: "triage-session",
    });
    const selector = new AgentExecutionUnitTierSelector(spawner, createConfig());

    await expect(selector.select(tierInput)).resolves.toEqual({
      tier: "small",
      reason: "result text fallback",
    });
  });

  it("falls back to COMPLEXITY_TRIAGE_FALLBACK when the agent call fails", async () => {
    const spawner = new FakeAgentSpawner();
    spawner.onNextSpawn("triage", () => {
      throw new Error("boom");
    });
    const selector = new AgentExecutionUnitTierSelector(spawner, createConfig());

    await expect(selector.select(tierInput)).resolves.toEqual(COMPLEXITY_TRIAGE_FALLBACK);
  });
});
