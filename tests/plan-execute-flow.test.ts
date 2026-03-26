import { describe, it, expect, vi } from "vitest";
import type { AgentResult, AgentProcess, AgentStyle } from "../src/agent.js";

// ─── Mock helpers ────────────────────────────────────────────────────────────

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test-session",
  ...overrides,
});

const makeAgent = (overrides: Partial<AgentProcess> = {}): AgentProcess =>
  ({
    send: vi.fn().mockResolvedValue(makeResult()),
    sendQuiet: vi.fn().mockResolvedValue(makeResult()),
    inject: vi.fn(),
    kill: vi.fn(),
    alive: true,
    stderr: "",
    style: { label: "TEST", color: "", badge: "" } as AgentStyle,
    ...overrides,
  }) as unknown as AgentProcess;

const noopStreamer = Object.assign(() => {}, { flush: () => {} });

describe("planThenExecute", () => {
  it("sends plan text to TDD agent as 'Execute this plan' prompt", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(
        makeResult({ planText: "## Cycle 1\nWrite a test" }),
      ),
    });

    const tddAgent = makeAgent();

    const result = await planThenExecute({
      sliceContent: "### Slice 3: Plan-then-execute",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
    });

    // Plan agent should have been called with slice content
    expect(planAgent.send).toHaveBeenCalledOnce();
    const planPrompt = (planAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(planPrompt).toContain("### Slice 3: Plan-then-execute");

    // TDD agent should receive "Execute this plan" with the plan text
    expect(tddAgent.send).toHaveBeenCalledOnce();
    const tddPrompt = (tddAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toContain("Execute this plan:");
    expect(tddPrompt).toContain("## Cycle 1\nWrite a test");

    // Result should be the TDD result
    expect(result.tddResult).toBeDefined();
  });

  it("falls back to assistantText when planText is undefined", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(
        makeResult({ assistantText: "Fallback plan from assistant", planText: undefined }),
      ),
    });

    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "### Slice 3: Fallback test",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
    });

    const tddPrompt = (tddAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toContain("Execute this plan:");
    expect(tddPrompt).toContain("Fallback plan from assistant");
  });

  it("kills the plan agent after extracting the plan", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(
        makeResult({ planText: "some plan" }),
      ),
    });

    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice content",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
    });

    expect(planAgent.kill).toHaveBeenCalledOnce();
  });

  it("returns skipped=true when skip flag is set during plan phase", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "plan" })),
    });

    const tddAgent = makeAgent();

    const result = await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => true, // skip flag set
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
    });

    expect(result.skipped).toBe(true);
    // TDD agent should NOT have been called
    expect(tddAgent.send).not.toHaveBeenCalled();
  });

  it("returns hardInterrupt guidance when plan phase is interrupted", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "partial plan" })),
    });

    const tddAgent = makeAgent();

    const result = await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => "Fix the tests first", // hard interrupt pending
      onToolUse: () => {},
      log: () => {},
    });

    expect(result.hardInterrupt).toBe("Fix the tests first");
    // TDD agent should NOT have been called — caller handles respawn
    expect(tddAgent.send).not.toHaveBeenCalled();
  });

  it("skips confirmation when noInteraction is true", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const askUser = vi.fn();
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });
    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
      noInteraction: true,
      askUser,
    });

    expect(askUser).not.toHaveBeenCalled();
    expect(tddAgent.send).toHaveBeenCalledOnce();
  });

  it("asks for confirmation and proceeds on 'y'", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const askUser = vi.fn().mockResolvedValue("y");
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });
    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
      noInteraction: false,
      askUser,
    });

    expect(askUser).toHaveBeenCalledOnce();
    expect(tddAgent.send).toHaveBeenCalledOnce();
    const prompt = askUser.mock.calls[0][0] as string;
    expect(prompt).toContain("Accept plan");
  });

  it("proceeds on empty input (Enter key)", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const askUser = vi.fn().mockResolvedValue("");
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });
    const tddAgent = makeAgent();

    const result = await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
      noInteraction: false,
      askUser,
    });

    expect(tddAgent.send).toHaveBeenCalledOnce();
    expect(result.replan).toBeUndefined();
  });

  it("logs truncated plan text before asking", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const lines = Array.from({ length: 50 }, (_, i) => `Step ${i + 1}`);
    const planText = lines.join("\n");
    const askUser = vi.fn().mockResolvedValue("y");
    const log = vi.fn();
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText })),
    });
    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log,
      noInteraction: false,
      askUser,
    });

    const loggedText = log.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(loggedText).toContain("Step 1");
    expect(loggedText).not.toContain("Step 50");
    expect(loggedText).toContain("truncated");
    expect(loggedText).toContain("50 lines");
  });

  it("asks for guidance on 'e' and prepends to execute prompt", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const askUser = vi.fn()
      .mockResolvedValueOnce("e")
      .mockResolvedValueOnce("Focus on error handling");
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan text" })),
    });
    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
      noInteraction: false,
      askUser,
    });

    expect(askUser).toHaveBeenCalledTimes(2);
    expect(tddAgent.send).toHaveBeenCalledOnce();
    const tddPrompt = (tddAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toContain("Focus on error handling");
    expect(tddPrompt).toContain("the plan text");
  });

  it("kills plan agent even when replanning", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const askUser = vi.fn().mockResolvedValue("r");
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });
    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
      noInteraction: false,
      askUser,
    });

    expect(planAgent.kill).toHaveBeenCalledOnce();
  });

  it("returns replan signal on 'r' input", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const askUser = vi.fn().mockResolvedValue("r");
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });
    const tddAgent = makeAgent();

    const result = await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
      noInteraction: false,
      askUser,
    });

    expect(result.replan).toBe(true);
    expect(result.skipped).toBe(false);
    expect(tddAgent.send).not.toHaveBeenCalled();
  });

  it("auto-accepts after max replans (caller loop simulation)", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const MAX_REPLANS = 2;
    const askUser = vi.fn().mockResolvedValue("r");
    let replanAttempts = 0;
    let lastResult: Awaited<ReturnType<typeof planThenExecute>>;

    do {
      const planAgent = makeAgent({
        send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
      });
      const tddAgent = makeAgent();

      lastResult = await planThenExecute({
        sliceContent: "slice",
        planAgent,
        tddAgent,
        brief: "",
        makePlanStreamer: () => noopStreamer,
        makeExecuteStreamer: () => noopStreamer,
        withInterrupt: (_agent, fn) => fn(),
        isSkipped: () => false,
        isHardInterrupted: () => null,
        onToolUse: () => {},
        log: () => {},
        noInteraction: false,
        askUser,
      });
      replanAttempts++;
    } while (lastResult.replan && replanAttempts < MAX_REPLANS);

    // After 2 replan attempts, caller should auto-accept by calling without askUser
    expect(lastResult.replan).toBe(true);
    expect(replanAttempts).toBe(2);

    // Auto-accept: call with noInteraction to bypass confirmation
    const finalPlanAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "final plan" })),
    });
    const finalTddAgent = makeAgent();
    const finalResult = await planThenExecute({
      sliceContent: "slice",
      planAgent: finalPlanAgent,
      tddAgent: finalTddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
      noInteraction: true,
    });

    expect(finalResult.replan).toBeUndefined();
    expect(finalResult.skipped).toBe(false);
    expect(finalTddAgent.send).toHaveBeenCalledOnce();
  });

  it("returns hardInterrupt guidance when execute phase is interrupted", async () => {
    const { planThenExecute } = await import("../src/main.js");

    let callCount = 0;
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });

    const tddAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult()),
    });

    const result = await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => {
        callCount++;
        // First call (after plan phase) returns null, second (after execute) returns guidance
        return callCount === 1 ? null : "Redirect to new approach";
      },
      onToolUse: () => {},
      log: () => {},
    });

    expect(result.hardInterrupt).toBe("Redirect to new approach");
    // TDD agent SHOULD have been called (plan phase passed)
    expect(tddAgent.send).toHaveBeenCalledOnce();
  });

  it("brief dep is accepted but not included in execute prompt (documents current behavior)", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });
    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "This is the project brief with important context",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
    });

    const tddPrompt = (tddAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // brief is not currently wired into the execute prompt — caller handles it via withBrief
    expect(tddPrompt).not.toContain("project brief");
    expect(tddPrompt).toContain("Execute this plan:");
  });

  it("execute prompt contains 'Execute this plan' even when plan is empty", async () => {
    const { planThenExecute } = await import("../src/main.js");

    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: undefined, assistantText: "" })),
    });
    const tddAgent = makeAgent();

    await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => false,
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
    });

    const tddPrompt = (tddAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toBe("Execute this plan:\n\n");
  });

  it("returns skipped=true when skip flag is set during execute phase", async () => {
    const { planThenExecute } = await import("../src/main.js");

    let callCount = 0;
    const planAgent = makeAgent({
      send: vi.fn().mockResolvedValue(makeResult({ planText: "the plan" })),
    });
    const tddAgent = makeAgent();

    const result = await planThenExecute({
      sliceContent: "slice",
      planAgent,
      tddAgent,
      brief: "",
      makePlanStreamer: () => noopStreamer,
      makeExecuteStreamer: () => noopStreamer,
      withInterrupt: (_agent, fn) => fn(),
      isSkipped: () => {
        callCount++;
        // First call (after plan phase) — not skipped; second (after execute) — skipped
        return callCount > 1;
      },
      isHardInterrupted: () => null,
      onToolUse: () => {},
      log: () => {},
    });

    expect(result.skipped).toBe(true);
    // TDD agent SHOULD have been called (plan phase passed)
    expect(tddAgent.send).toHaveBeenCalledOnce();
  });
});
