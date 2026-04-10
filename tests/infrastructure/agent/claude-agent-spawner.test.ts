import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
import type { AgentRole } from "#domain/agent-types.js";

const { spawnClaudeAgent, spawnClaudePlanAgent } = vi.hoisted(() => ({
  spawnClaudeAgent: vi.fn(),
  spawnClaudePlanAgent: vi.fn(),
}));

vi.mock("#infrastructure/agent/claude-process.js", () => ({
  spawnClaudeAgent,
  spawnClaudePlanAgent,
}));

import { ClaudeAgentSpawner, ROLE_STYLES } from "#infrastructure/agent/claude-agent-spawner.js";

const makeHandle = (sessionId: string): AgentHandle => ({
  sessionId,
  style: ROLE_STYLES.tdd,
  alive: true,
  stderr: "",
  send: vi.fn(),
  sendQuiet: vi.fn(),
  inject: vi.fn(),
  kill: vi.fn(),
  pipe: vi.fn(),
});

describe("ClaudeAgentSpawner", () => {
  beforeEach(() => {
    spawnClaudeAgent.mockReset();
    spawnClaudePlanAgent.mockReset();
    spawnClaudeAgent.mockReturnValue(makeHandle("agent-session"));
    spawnClaudePlanAgent.mockReturnValue(makeHandle("plan-session"));
  });

  const createSpawner = (
    skills: Partial<Record<AgentRole, string | null>> = {},
    cwd = "/workspace",
  ): ClaudeAgentSpawner => new ClaudeAgentSpawner(skills, cwd);

  it.each(["plan", "gap", "completeness", "triage"] as const)(
    "routes %s through the plan-mode Claude process",
    (role) => {
      const spawner = createSpawner();

      const handle = spawner.spawn(role);

      expect(handle.sessionId).toBe("plan-session");
      expect(spawnClaudePlanAgent).toHaveBeenCalledOnce();
      expect(spawnClaudeAgent).not.toHaveBeenCalled();
    },
  );

  it.each(["tdd", "review", "verify", "final"] as const)(
    "routes %s through the normal Claude process",
    (role) => {
      const spawner = createSpawner();

      const handle = spawner.spawn(role);

      expect(handle.sessionId).toBe("agent-session");
      expect(spawnClaudeAgent).toHaveBeenCalledOnce();
      expect(spawnClaudePlanAgent).not.toHaveBeenCalled();
    },
  );

  it("passes system prompts from the role skill map by default", () => {
    const spawner = createSpawner({ tdd: "system skill" });

    spawner.spawn("tdd");

    expect(spawnClaudeAgent).toHaveBeenCalledWith(
      ROLE_STYLES.tdd,
      "system skill",
      undefined,
      "/workspace",
      undefined,
    );
  });

  it("lets the explicit system prompt override the role skill", () => {
    const spawner = createSpawner({ tdd: "system skill" });

    spawner.spawn("tdd", { systemPrompt: "override", cwd: "/custom" });

    expect(spawnClaudeAgent).toHaveBeenCalledWith(
      ROLE_STYLES.tdd,
      "override",
      undefined,
      "/custom",
      undefined,
    );
  });

  it("forwards resume session IDs to normal agents", () => {
    const spawner = createSpawner();

    spawner.spawn("tdd", { resumeSessionId: "sess-123" });

    expect(spawnClaudeAgent).toHaveBeenCalledWith(
      ROLE_STYLES.tdd,
      undefined,
      "sess-123",
      "/workspace",
      undefined,
    );
  });

  it("uses the Haiku triage model by default", () => {
    const spawner = createSpawner({ triage: "triage-skill" });

    spawner.spawn("triage");

    expect(spawnClaudePlanAgent).toHaveBeenCalledWith(
      ROLE_STYLES.triage,
      "triage-skill",
      "/workspace",
      "claude-haiku-4-5-20251001",
    );
  });

  it("forwards an explicit model override", () => {
    const spawner = createSpawner();

    spawner.spawn("plan", { model: "claude-sonnet" });
    spawner.spawn("tdd", { model: "claude-opus" });

    expect(spawnClaudePlanAgent).toHaveBeenCalledWith(
      ROLE_STYLES.plan,
      undefined,
      "/workspace",
      "claude-sonnet",
    );
    expect(spawnClaudeAgent).toHaveBeenCalledWith(
      ROLE_STYLES.tdd,
      undefined,
      undefined,
      "/workspace",
      "claude-opus",
    );
  });

  it("forces plan mode for non-plan roles when requested", () => {
    const spawner = createSpawner();

    spawner.spawn("tdd", { planMode: true, cwd: "/planning" });

    expect(spawnClaudePlanAgent).toHaveBeenCalledWith(
      ROLE_STYLES.tdd,
      undefined,
      "/planning",
      undefined,
    );
    expect(spawnClaudeAgent).not.toHaveBeenCalled();
  });

  it("exports styles for every agent role", () => {
    expect(Object.keys(ROLE_STYLES)).toEqual([
      "tdd",
      "review",
      "verify",
      "plan",
      "gap",
      "final",
      "completeness",
      "triage",
    ]);
  });
});
