import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock createAgent before any imports that use it
vi.mock("../../src/infrastructure/claude/claude-agent-process.js", () => ({
  createClaudeAgent: vi.fn(() => ({
    send: vi.fn(),
    sendQuiet: vi.fn().mockResolvedValue(undefined),
    inject: vi.fn(),
    kill: vi.fn(),
    alive: true,
    stderr: "",
    style: { label: "TEST", color: "", badge: "" },
  })),
}));

import { createClaudeAgent } from "../../src/infrastructure/claude/claude-agent-process.js";
import type { Mock } from "vitest";

const mockedCreateAgent = createClaudeAgent as Mock;

const loadModule = async () => {
  const mod = await import("../../src/infrastructure/claude/claude-agent-factory.js");
  return mod;
};

describe("spawnClaudeAgent", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("passes --dangerously-skip-permissions", async () => {
    const { spawnClaudeAgent } = await loadModule();

    spawnClaudeAgent({ label: "TDD", color: "", badge: "" });

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--dangerously-skip-permissions");
  });
});

describe("spawnClaudePlanAgent", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("passes --permission-mode plan instead of --dangerously-skip-permissions", async () => {
    const { spawnClaudePlanAgent } = await loadModule();

    spawnClaudePlanAgent({ label: "PLAN", color: "", badge: "" });

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passes system prompt via --append-system-prompt when provided", async () => {
    const { spawnClaudePlanAgent } = await loadModule();

    spawnClaudePlanAgent({ label: "PLAN", color: "", badge: "" }, "You are a planner.");

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are a planner.");
  });

  it("omits --append-system-prompt when no system prompt provided", async () => {
    const { spawnClaudePlanAgent } = await loadModule();

    spawnClaudePlanAgent({ label: "PLAN", color: "", badge: "" });

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).not.toContain("--append-system-prompt");
  });

  it("passes --model when a model override is provided", async () => {
    const { spawnClaudePlanAgent } = await loadModule();

    spawnClaudePlanAgent(
      { label: "PLAN", color: "", badge: "" },
      undefined,
      undefined,
      "claude-haiku-4-5-20251001",
    );

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  });

  it("omits --model when no model override is provided", async () => {
    const { spawnClaudePlanAgent } = await loadModule();

    spawnClaudePlanAgent({ label: "PLAN", color: "", badge: "" });

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).not.toContain("--model");
  });

  it("forwards the provided style to createClaudeAgent", async () => {
    const { spawnClaudePlanAgent } = await loadModule();

    const style = { label: "PLAN", color: "white", badge: " PLN " };
    spawnClaudePlanAgent(style);

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    expect(callArgs.style).toBe(style);
  });
});

describe("spawnClaudePlanAgentWithSkill", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("spawns a plan agent with plan.md content as system prompt", async () => {
    const { spawnClaudePlanAgentWithSkill } = await loadModule();

    spawnClaudePlanAgentWithSkill();

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    // Should use plan permissions, not dangerously-skip-permissions
    expect(args).toContain("--permission-mode");
    // Should pass plan.md content as system prompt
    expect(args).toContain("--append-system-prompt");
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("spawnClaudeAgent resume mode", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("uses --resume <id> instead of -p when resumeSessionId is provided", async () => {
    const { spawnClaudeAgent } = await loadModule();

    spawnClaudeAgent({ label: "TDD", color: "", badge: "" }, undefined, "session-abc");

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("session-abc");
    expect(args).not.toContain("-p");
  });

  it("passes resumeSessionId as sessionId to createClaudeAgent", async () => {
    const { spawnClaudeAgent } = await loadModule();

    spawnClaudeAgent({ label: "TDD", color: "", badge: "" }, undefined, "session-abc");

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    expect(callArgs.sessionId).toBe("session-abc");
  });

  it("uses -p when no resumeSessionId is provided", async () => {
    const { spawnClaudeAgent } = await loadModule();

    spawnClaudeAgent({ label: "TDD", color: "", badge: "" });

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("-p");
    expect(args).not.toContain("--resume");
  });
});

describe("buildRulesReminder", () => {
  it("returns base rules when no extra rules", async () => {
    const { buildRulesReminder } = await loadModule();
    expect(buildRulesReminder("base rules")).toBe("base rules");
  });

  it("handles empty string extra as no-op", async () => {
    const { buildRulesReminder } = await loadModule();
    expect(buildRulesReminder("base rules", "")).toBe("base rules");
  });

  it("appends extra rules with project header", async () => {
    const { buildRulesReminder } = await loadModule();
    const result = buildRulesReminder("base rules", "no mocking");
    expect(result).toBe("base rules\n\n[PROJECT] Additional rules from .orchrc.json:\nno mocking");
  });
});

describe("rule constants", () => {
  it("TDD_RULES_REMINDER contains 'RUN TESTS WITH BASH'", async () => {
    const { TDD_RULES_REMINDER } = await loadModule();
    expect(TDD_RULES_REMINDER).toContain("RUN TESTS WITH BASH");
  });

  it("REVIEW_RULES_REMINDER contains 'ONLY REVIEW THE DIFF'", async () => {
    const { REVIEW_RULES_REMINDER } = await loadModule();
    expect(REVIEW_RULES_REMINDER).toContain("ONLY REVIEW THE DIFF");
  });
});
