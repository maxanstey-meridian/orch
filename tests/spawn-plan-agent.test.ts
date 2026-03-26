import { describe, it, expect, vi, beforeEach } from "vitest";

// We'll mock createAgent to inspect what args spawnPlanAgent passes
vi.mock("../src/agent.js", () => ({
  createAgent: vi.fn(() => ({
    send: vi.fn(),
    sendQuiet: vi.fn(),
    inject: vi.fn(),
    kill: vi.fn(),
    alive: true,
    stderr: "",
    style: { label: "PLAN", color: "", badge: "" },
  })),
}));

import { createAgent } from "../src/agent.js";
import type { Mock } from "vitest";

const mockedCreateAgent = createAgent as Mock;

// Dynamic import to get the module after mock is set up
const loadModule = async () => {
  // Clear module cache so the mock takes effect
  const mod = await import("../src/main.js");
  return mod;
};

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
