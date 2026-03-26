import { describe, it, expect, vi } from "vitest";
import { Orchestrator, type OrchestratorConfig } from "../src/orchestrator.js";
import type { AgentProcess, AgentStyle } from "../src/agent.js";
import type { Hud, KeyHandler, InterruptSubmitHandler } from "../src/hud.js";

const makeConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp",
  planPath: "/tmp/plan.md",
  planContent: "## Group: Test\n### Slice 1: Noop\nDo nothing.",
  brief: "",
  noInteraction: false,
  auto: false,
  reviewThreshold: 2,
  stateFile: "/tmp/state.json",
  tddSkill: "skill-tdd",
  reviewSkill: "skill-review",
  verifySkill: "skill-verify",
  ...overrides,
});

const fakeAgent = (): AgentProcess => ({
  kill: vi.fn(),
  inject: vi.fn(),
  send: vi.fn().mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" }),
  sendQuiet: vi.fn().mockResolvedValue(""),
  alive: true,
  sessionId: "test",
  style: { label: "TEST", color: "C", badge: "B" },
  stderr: "",
});

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

const makeOrch = (overrides?: {
  config?: Partial<OrchestratorConfig>;
  tddAgent?: AgentProcess;
  reviewAgent?: AgentProcess;
  hud?: ReturnType<typeof fakeHud>;
  spawnTdd?: () => Promise<AgentProcess>;
  spawnReview?: () => Promise<AgentProcess>;
}) => {
  const tdd = overrides?.tddAgent ?? fakeAgent();
  const review = overrides?.reviewAgent ?? fakeAgent();
  const hudHelper = overrides?.hud ?? fakeHud();
  const orch = new Orchestrator(
    makeConfig(overrides?.config),
    {},
    hudHelper.hud,
    vi.fn(),
    tdd,
    review,
    overrides?.spawnTdd ?? (() => Promise.resolve(fakeAgent())),
    overrides?.spawnReview ?? (() => Promise.resolve(fakeAgent())),
  );
  return { orch, tdd, review, ...hudHelper };
};

describe("OrchestratorConfig", () => {
  it("has required fields", () => {
    const config = makeConfig();
    expect(typeof config.cwd).toBe("string");
    expect(typeof config.reviewThreshold).toBe("number");
    expect(typeof config.noInteraction).toBe("boolean");
    expect(Orchestrator).toBeDefined();
  });
});

describe("Orchestrator constructor", () => {
  it("initialises agent lifecycle and interrupt fields", () => {
    const { orch } = makeOrch();
    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(true);
    expect(orch.interruptTarget).toBeNull();
    expect(orch.sliceSkippable).toBe(false);
    expect(orch.sliceSkipFlag).toBe(false);
    expect(orch.hardInterruptPending).toBeNull();
    expect(orch.slicesCompleted).toBe(0);
  });
});

describe("respawnTdd", () => {
  it("kills old agent, spawns fresh, resets both first-message flags", async () => {
    const oldTdd = fakeAgent();
    const newTdd = fakeAgent();
    const spawnTdd = vi.fn().mockResolvedValue(newTdd);
    const { orch } = makeOrch({ tddAgent: oldTdd, spawnTdd });
    orch.tddIsFirst = false;
    orch.reviewIsFirst = false;

    await orch.respawnTdd();

    expect(oldTdd.kill).toHaveBeenCalled();
    expect(orch.tddAgent).toBe(newTdd);
    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(true);
  });
});

describe("respawnBoth", () => {
  it("kills both agents, spawns fresh, resets both flags", async () => {
    const oldTdd = fakeAgent();
    const oldReview = fakeAgent();
    const newTdd = fakeAgent();
    const newReview = fakeAgent();
    const spawnTdd = vi.fn().mockResolvedValue(newTdd);
    const spawnReview = vi.fn().mockResolvedValue(newReview);
    const { orch } = makeOrch({ tddAgent: oldTdd, reviewAgent: oldReview, spawnTdd, spawnReview });
    orch.tddIsFirst = false;
    orch.reviewIsFirst = false;

    await orch.respawnBoth();

    expect(oldTdd.kill).toHaveBeenCalled();
    expect(oldReview.kill).toHaveBeenCalled();
    expect(orch.tddAgent).toBe(newTdd);
    expect(orch.reviewAgent).toBe(newReview);
    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(true);
  });
});

describe("setupKeyboardHandlers", () => {
  it("key 'i' with interruptTarget starts interrupt prompt", () => {
    const { orch, hud, pressKey } = makeOrch();
    orch.setupKeyboardHandlers();
    orch.interruptTarget = fakeAgent();
    pressKey("i");
    expect(hud.startPrompt).toHaveBeenCalledWith("interrupt");
  });

  it("key 'g' with interruptTarget starts guide prompt", () => {
    const { orch, hud, pressKey } = makeOrch();
    orch.setupKeyboardHandlers();
    orch.interruptTarget = fakeAgent();
    pressKey("g");
    expect(hud.startPrompt).toHaveBeenCalledWith("guide");
  });

  it("key 's' with sliceSkippable toggles skip flag", () => {
    const { orch, hud, pressKey } = makeOrch();
    orch.setupKeyboardHandlers();
    orch.sliceSkippable = true;
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(true);
    expect(hud.setSkipping).toHaveBeenCalledWith(true);
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(false);
    expect(hud.setSkipping).toHaveBeenCalledWith(false);
  });

  it("key 'q' calls cleanup and exits", () => {
    const { orch, hud, pressKey } = makeOrch();
    orch.setupKeyboardHandlers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    pressKey("q");
    expect(hud.teardown).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });
});

describe("onInterruptSubmit", () => {
  it("guide mode injects text into interruptTarget", () => {
    const { orch, submitInterrupt } = makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    orch.interruptTarget = target;
    submitInterrupt("fix the test", "guide");
    expect(target.inject).toHaveBeenCalledWith("fix the test");
  });

  it("interrupt mode sets hardInterruptPending and kills target", () => {
    const { orch, submitInterrupt } = makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    orch.interruptTarget = target;
    submitInterrupt("rewrite approach", "interrupt");
    expect(orch.hardInterruptPending).toBe("rewrite approach");
    expect(target.kill).toHaveBeenCalled();
  });
});

describe("cleanup", () => {
  it("tears down hud and kills both agents", () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    const { orch, hud } = makeOrch({ tddAgent: tdd, reviewAgent: review });
    orch.cleanup();
    expect(hud.teardown).toHaveBeenCalled();
    expect(tdd.kill).toHaveBeenCalled();
    expect(review.kill).toHaveBeenCalled();
  });
});

describe("streamer", () => {
  it("returns Streamer that clears activity on first text", () => {
    const hudHelper = fakeHud();
    const captured: string[] = [];
    (hudHelper.hud.createWriter as ReturnType<typeof vi.fn>).mockReturnValue((t: string) => { captured.push(t); });
    const { orch } = makeOrch({ hud: hudHelper });
    const s = orch.streamer({ label: "T", color: "C", badge: "B" });
    // Simulate activity showing
    orch.activityShowing = true;
    s("hello");
    expect(hudHelper.hud.setActivity).toHaveBeenCalledWith("");
    expect(captured.length).toBeGreaterThan(0);
  });
});

describe("run", () => {
  it("throws NotImplementedError", () => {
    const { orch } = makeOrch();
    expect(() => orch.run()).toThrow("not yet implemented");
  });
});
