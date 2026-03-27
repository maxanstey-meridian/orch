import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock createAgent before any imports that use it
vi.mock("../src/agent.js", () => ({
  createAgent: vi.fn(() => ({
    send: vi.fn(),
    sendQuiet: vi.fn(),
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

  it("passes --permission-mode plan", async () => {
    const { spawnPlanAgent } = await loadModule();

    spawnPlanAgent({ label: "PLAN", color: "", badge: "" });

    expect(mockedCreateAgent).toHaveBeenCalledOnce();
    const callArgs = mockedCreateAgent.mock.calls[0][0];
    const args: string[] = callArgs.args;

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
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
