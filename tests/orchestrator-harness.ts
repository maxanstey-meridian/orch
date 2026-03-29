import type { OrchestratorConfig } from "../src/orchestrator.js";
import type { AgentProcess, AgentResult } from "../src/agent/agent.js";
import type { Hud, KeyHandler, InterruptSubmitHandler } from "../src/ui/hud.js";
import { Orchestrator } from "../src/orchestrator.js";
import { vi } from "vitest";

const makeConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp",
  planPath: "/tmp/plan.md",
  planContent: "## Group: Test\n### Slice 1: Noop\nDo nothing.",
  brief: "",
  noInteraction: false,
  auto: false,
  reviewThreshold: 2,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  tddSkill: "skill-tdd",
  reviewSkill: "skill-review",
  verifySkill: "skill-verify",
  gapDisabled: false,
  planDisabled: false,
  maxReplans: 2,
  ...overrides,
});

export const defaultResult: AgentResult = {
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "s",
};

export const fakeAgent = (): AgentProcess & { nextResult: (r: Partial<AgentResult>) => void } => {
  const queue: Partial<AgentResult>[] = [];
  const agent: AgentProcess & { nextResult: (r: Partial<AgentResult>) => void } = {
    kill: vi.fn(),
    inject: vi.fn(),
    send: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      return Promise.resolve(next ? { ...defaultResult, ...next } : defaultResult);
    }),
    sendQuiet: vi.fn().mockResolvedValue(""),
    alive: true,
    sessionId: "test",
    style: { label: "TEST", color: "C", badge: "B" },
    stderr: "",
    nextResult: (r: Partial<AgentResult>) => queue.push(r),
  };
  return agent;
};

const fakeHud = () => {
  let keyHandler: KeyHandler | null = null;
  let interruptHandler: InterruptSubmitHandler | null = null;
  const hud: Hud = {
    update: vi.fn(),
    teardown: vi.fn(),
    wrapLog: vi.fn((fn) => fn),
    createWriter: vi.fn(() => vi.fn()),
    onKey: vi.fn((h) => { keyHandler = h; }),
    onInterruptSubmit: vi.fn((h) => { interruptHandler = h; }),
    startPrompt: vi.fn(),
    setSkipping: vi.fn(),
    setActivity: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
  };
  return {
    hud,
    pressKey: (k: string) => keyHandler?.(k),
    submitInterrupt: (text: string, mode: "guide" | "interrupt") => interruptHandler?.(text, mode),
  };
};

export const createTestOrch = async (overrides?: Partial<OrchestratorConfig>) => {
  const tdd = fakeAgent();
  const review = fakeAgent();
  const hudHelper = fakeHud();
  const log = vi.fn();

  const orch = await Orchestrator.create(
    makeConfig(overrides),
    {},
    hudHelper.hud,
    log,
    { tdd, review },
  );

  orch.setupKeyboardHandlers();

  const getHudCalls = () => ({
    update: (hudHelper.hud.update as ReturnType<typeof vi.fn>).mock.calls,
    setSkipping: (hudHelper.hud.setSkipping as ReturnType<typeof vi.fn>).mock.calls,
  });

  return {
    orch,
    pressKey: hudHelper.pressKey,
    submitInterrupt: hudHelper.submitInterrupt,
    getHudCalls,
    agents: { tdd, review },
    hud: hudHelper.hud,
    log,
  };
};
