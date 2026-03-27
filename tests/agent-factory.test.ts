import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock createAgent before any imports that use it
vi.mock("../src/agent.js", () => ({
  createAgent: vi.fn(() => ({
    send: vi.fn(),
    sendQuiet: vi.fn().mockResolvedValue(undefined),
    inject: vi.fn(),
    kill: vi.fn(),
    alive: true,
    stderr: "",
    style: { label: "TEST", color: "", badge: "" },
  })),
}));

import { createAgent } from "../src/agent.js";
import type { Mock } from "vitest";

const mockedCreateAgent = createAgent as Mock;

const loadModule = async () => {
  const mod = await import("../src/agent-factory.js");
  return mod;
};

describe("spawnAgent", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("passes --dangerously-skip-permissions", async () => {
    const { spawnAgent } = await loadModule();

    spawnAgent({ label: "TDD", color: "", badge: "" });

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--dangerously-skip-permissions");
  });
});

describe("spawnPlanAgent", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("passes --permission-mode plan instead of --dangerously-skip-permissions", async () => {
    const { spawnPlanAgent } = await loadModule();

    spawnPlanAgent({ label: "PLAN", color: "", badge: "" });

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passes system prompt via --append-system-prompt when provided", async () => {
    const { spawnPlanAgent } = await loadModule();

    spawnPlanAgent({ label: "PLAN", color: "", badge: "" }, "You are a planner.");

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are a planner.");
  });

  it("omits --append-system-prompt when no system prompt provided", async () => {
    const { spawnPlanAgent } = await loadModule();

    spawnPlanAgent({ label: "PLAN", color: "", badge: "" });

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).not.toContain("--append-system-prompt");
  });

  it("forwards the provided style to createAgent", async () => {
    const { spawnPlanAgent } = await loadModule();

    const style = { label: "PLAN", color: "white", badge: " PLN " };
    spawnPlanAgent(style);

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    expect(callArgs.style).toBe(style);
  });
});

describe("spawnTddAgent", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("sends TDD_RULES_REMINDER via sendQuiet", async () => {
    const { spawnTddAgent } = await loadModule();

    const agent = await spawnTddAgent("tdd skill content");

    expect(agent.sendQuiet).toHaveBeenCalledOnce();
    const reminder = (agent.sendQuiet as Mock).mock.calls[0][0] as string;
    expect(reminder).toContain("RUN TESTS WITH BASH");
  });

  it("passes skill as system prompt to spawnAgent", async () => {
    const { spawnTddAgent } = await loadModule();

    await spawnTddAgent("my-tdd-skill");

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("my-tdd-skill");
  });
});

describe("spawnReviewAgent", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("sends REVIEW_RULES_REMINDER via sendQuiet", async () => {
    const { spawnReviewAgent } = await loadModule();

    const agent = await spawnReviewAgent("review skill content");

    expect(agent.sendQuiet).toHaveBeenCalledOnce();
    const reminder = (agent.sendQuiet as Mock).mock.calls[0][0] as string;
    expect(reminder).toContain("ONLY REVIEW THE DIFF");
  });

  it("passes skill as system prompt to spawnAgent", async () => {
    const { spawnReviewAgent } = await loadModule();

    await spawnReviewAgent("my-review-skill");

    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("my-review-skill");
  });
});

describe("spawnPlanAgentWithSkill", () => {
  beforeEach(() => {
    mockedCreateAgent.mockClear();
  });

  it("spawns a plan agent with plan.md content as system prompt", async () => {
    const { spawnPlanAgentWithSkill } = await loadModule();

    spawnPlanAgentWithSkill();

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
