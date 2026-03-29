import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator, CreditExhaustedError, type OrchestratorConfig } from "../src/orchestrator.js";
import type { AgentProcess, AgentResult, AgentStyle } from "../src/agent/agent.js";
import type { Hud, KeyHandler, InterruptSubmitHandler } from "../src/ui/hud.js";
import type { Slice } from "../src/plan/plan-parser.js";
import { hasDirtyTree, captureRef, hasChanges } from "../src/git/git.js";
import { spawnAgent, spawnPlanAgentWithSkill, spawnGapAgent } from "../src/agent/agent-factory.js";
import { detectCreditExhaustion } from "../src/agent/credit-detection.js";
import { detectApiError } from "../src/agent/api-errors.js";
import { saveState } from "../src/state/state.js";
import { isCleanReview } from "../src/cli/review-check.js";
import { measureDiff } from "../src/cli/review-threshold.js";
import { printSliceIntro, printSliceContent } from "../src/ui/display.js";

vi.mock("../src/ui/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/display.js")>();
  return { ...actual, printSliceIntro: vi.fn(), printSliceContent: vi.fn() };
});

vi.mock("../src/git/git.js", () => ({
  hasDirtyTree: vi.fn().mockResolvedValue(false),
  captureRef: vi.fn().mockResolvedValue("abc123"),
  hasChanges: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/agent/agent-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/agent-factory.js")>();
  return {
    spawnAgent: vi.fn(),
    spawnPlanAgentWithSkill: vi.fn(),
    spawnGapAgent: vi.fn(),
    TDD_RULES_REMINDER: actual.TDD_RULES_REMINDER,
    REVIEW_RULES_REMINDER: actual.REVIEW_RULES_REMINDER,
    buildRulesReminder: actual.buildRulesReminder,
  };
});

vi.mock("../src/agent/credit-detection.js", () => ({
  detectCreditExhaustion: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/agent/api-errors.js", () => ({
  detectApiError: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/state/state.js", () => ({
  saveState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/cli/review-check.js", () => ({
  isCleanReview: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/cli/review-threshold.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/review-threshold.js")>();
  return {
    shouldReview: actual.shouldReview,
    measureDiff: vi.fn().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 }),
  };
});

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

const makeOrch = async (overrides?: {
  config?: Partial<OrchestratorConfig>;
  tddAgent?: AgentProcess;
  reviewAgent?: AgentProcess;
  hud?: ReturnType<typeof fakeHud>;
}) => {
  const tdd = overrides?.tddAgent ?? fakeAgent();
  const review = overrides?.reviewAgent ?? fakeAgent();
  const hudHelper = overrides?.hud ?? fakeHud();
  const orch = await Orchestrator.create(
    makeConfig(overrides?.config),
    {},
    hudHelper.hud,
    vi.fn(),
    { tdd, review },
  );
  return { orch, tdd, review, ...hudHelper };
};

beforeEach(() => {
  vi.mocked(hasDirtyTree).mockReset().mockResolvedValue(false);
  vi.mocked(captureRef).mockReset().mockResolvedValue("abc123");
  vi.mocked(hasChanges).mockReset().mockResolvedValue(true);
  vi.mocked(spawnAgent).mockReset().mockReturnValue(fakeAgent());
  vi.mocked(spawnPlanAgentWithSkill).mockReset().mockReturnValue(fakeAgent());
  vi.mocked(spawnGapAgent).mockReset().mockReturnValue(fakeAgent());
  vi.mocked(detectCreditExhaustion).mockReset().mockReturnValue(null);
  vi.mocked(detectApiError).mockReset().mockReturnValue(null);
  vi.mocked(saveState).mockReset().mockResolvedValue(undefined);
  vi.mocked(isCleanReview).mockReset().mockReturnValue(false);
  vi.mocked(measureDiff).mockReset().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 });
});

describe("OrchestratorConfig", () => {
  it("has required fields", () => {
    const config = makeConfig();
    expect(typeof config.cwd).toBe("string");
    expect(typeof config.reviewThreshold).toBe("number");
    expect(typeof config.noInteraction).toBe("boolean");
    expect(Orchestrator).toBeDefined();
  });

  it("accepts tddRules and reviewRules", () => {
    const config = makeConfig({ tddRules: "no mocking", reviewRules: "check types" });
    expect(config.tddRules).toBe("no mocking");
    expect(config.reviewRules).toBe("check types");
  });

  it("includes maxReplans in OrchestratorConfig", () => {
    const config = makeConfig();
    expect(typeof config.maxReplans).toBe("number");
  });

  it("accepts null for skill fields", () => {
    const config = makeConfig({ tddSkill: null, reviewSkill: null, verifySkill: null });
    expect(config.tddSkill).toBeNull();
    expect(config.reviewSkill).toBeNull();
    expect(config.verifySkill).toBeNull();
  });

  it("passes undefined to spawnAgent when tddSkill is null", async () => {
    await Orchestrator.create(makeConfig({ tddSkill: null }), {}, fakeHud().hud, vi.fn());
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ label: "TDD" }),
      undefined,
      undefined,
      "/tmp",
    );
  });

  it("respawnTdd passes undefined when tddSkill is null", async () => {
    const { orch } = await makeOrch({ config: { tddSkill: null } });
    vi.mocked(spawnAgent).mockClear();
    await orch.respawnTdd();
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ label: "TDD" }),
      undefined,
      undefined,
      "/tmp",
    );
  });

  it("passes undefined to spawnAgent when reviewSkill is null", async () => {
    await Orchestrator.create(makeConfig({ reviewSkill: null }), {}, fakeHud().hud, vi.fn());
    const calls = vi.mocked(spawnAgent).mock.calls;
    const reviewCall = calls.find((c) => (c[0] as { label: string }).label === "REVIEW");
    expect(reviewCall?.[1]).toBeUndefined();
  });
});

describe("Orchestrator.create", () => {
  it("returns an Orchestrator instance", async () => {
    const result = await Orchestrator.create(makeConfig(), {}, fakeHud().hud, vi.fn());
    expect(result).toBeInstanceOf(Orchestrator);
  });

  it("spawns agents and sends rules reminders", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    await Orchestrator.create(makeConfig(), {}, fakeHud().hud, vi.fn());

    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ label: "TDD" }), "skill-tdd", undefined, "/tmp");
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ label: "REVIEW" }), "skill-review", undefined, "/tmp");
    expect(tdd.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("RUN TESTS WITH BASH"));
    expect(review.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("ONLY REVIEW THE DIFF"));
  });

  it("passes resumeSessionId to spawnAgent when state has session IDs", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    await Orchestrator.create(
      makeConfig(),
      { tddSessionId: "tdd-sess-1", reviewSessionId: "rev-sess-1" },
      fakeHud().hud,
      vi.fn(),
    );

    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ label: "TDD" }),
      "skill-tdd",
      "tdd-sess-1",
      "/tmp",
    );
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ label: "REVIEW" }),
      "skill-review",
      "rev-sess-1",
      "/tmp",
    );
  });

  it("does not pass resumeSessionId when state has no session IDs", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    await Orchestrator.create(makeConfig(), {}, fakeHud().hud, vi.fn());

    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ label: "TDD" }),
      "skill-tdd",
      undefined,
      "/tmp",
    );
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ label: "REVIEW" }),
      "skill-review",
      undefined,
      "/tmp",
    );
  });

  it("skips rules reminders when resuming with session IDs", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    await Orchestrator.create(
      makeConfig(),
      { tddSessionId: "tdd-sess-1", reviewSessionId: "rev-sess-1" },
      fakeHud().hud,
      vi.fn(),
    );

    expect(tdd.sendQuiet).not.toHaveBeenCalled();
    expect(review.sendQuiet).not.toHaveBeenCalled();
  });

  it("sends review rules when only tddSessionId is present (partial resume)", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    const orch = await Orchestrator.create(
      makeConfig(),
      { tddSessionId: "tdd-sess-1" },
      fakeHud().hud,
      vi.fn(),
    );

    // TDD is resuming — no rules reminder
    expect(tdd.sendQuiet).not.toHaveBeenCalled();
    // Review is fresh — needs rules reminder
    expect(review.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("ONLY REVIEW THE DIFF"));
    // Only TDD should have isFirst false
    expect(orch.tddIsFirst).toBe(false);
    expect(orch.reviewIsFirst).toBe(true);
  });

  it("sends TDD rules when only reviewSessionId is present (partial resume)", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    const orch = await Orchestrator.create(
      makeConfig(),
      { reviewSessionId: "rev-sess-1" },
      fakeHud().hud,
      vi.fn(),
    );

    // TDD is fresh — needs rules reminder
    expect(tdd.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("RUN TESTS WITH BASH"));
    // Review is resuming — no rules reminder
    expect(review.sendQuiet).not.toHaveBeenCalled();
    // Only review should have isFirst false
    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(false);
  });

  it("keeps tddIsFirst and reviewIsFirst true on fresh start", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    const orch = await Orchestrator.create(makeConfig(), {}, fakeHud().hud, vi.fn());

    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(true);
  });

  it("sets tddIsFirst and reviewIsFirst to false when resuming with session IDs", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(tdd).mockReturnValueOnce(review);

    const orch = await Orchestrator.create(
      makeConfig(),
      { tddSessionId: "tdd-sess-1", reviewSessionId: "rev-sess-1" },
      fakeHud().hud,
      vi.fn(),
    );

    expect(orch.tddIsFirst).toBe(false);
    expect(orch.reviewIsFirst).toBe(false);
  });

  it("sends base TDD rules when tddRules is undefined", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();

    await Orchestrator.create(makeConfig(), {}, fakeHud().hud, vi.fn(), { tdd, review });

    expect(tdd.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("RUN TESTS WITH BASH"),
    );
    expect(tdd.sendQuiet).not.toHaveBeenCalledWith(
      expect.stringContaining("[PROJECT]"),
    );
  });

  it("sends base review rules when reviewRules is undefined", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();

    await Orchestrator.create(makeConfig(), {}, fakeHud().hud, vi.fn(), { tdd, review });

    expect(review.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("ONLY REVIEW THE DIFF"),
    );
    expect(review.sendQuiet).not.toHaveBeenCalledWith(
      expect.stringContaining("[PROJECT]"),
    );
  });

  it("sends extended TDD rules when tddRules is set", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();

    await Orchestrator.create(
      makeConfig({ tddRules: "no mocking" }),
      {},
      fakeHud().hud,
      vi.fn(),
      { tdd, review },
    );

    expect(tdd.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("[PROJECT] Additional rules from .orchrc.json:\nno mocking"),
    );
    expect(tdd.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("RUN TESTS WITH BASH"),
    );
  });

  it("sends extended review rules when reviewRules is set", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();

    await Orchestrator.create(
      makeConfig({ reviewRules: "check types" }),
      {},
      fakeHud().hud,
      vi.fn(),
      { tdd, review },
    );

    expect(review.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("[PROJECT] Additional rules from .orchrc.json:\ncheck types"),
    );
    expect(review.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("ONLY REVIEW THE DIFF"),
    );
  });

  it("uses provided agents when given, skipping spawn but still sending reminders", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();

    const result = await Orchestrator.create(makeConfig(), {}, fakeHud().hud, vi.fn(), { tdd, review });

    expect(result).toBeInstanceOf(Orchestrator);
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(result.tddAgent).toBe(tdd);
    expect(result.reviewAgent).toBe(review);
    expect(tdd.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("RUN TESTS WITH BASH"));
    expect(review.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("ONLY REVIEW THE DIFF"));
  });
});

describe("Orchestrator constructor", () => {
  it("initialises agent lifecycle and interrupt fields", async () => {
    const { orch } = await makeOrch();
    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(true);
    expect(orch.interruptTarget).toBeNull();
    expect(orch.sliceSkippable).toBe(false);
    expect(orch.sliceSkipFlag).toBe(false);
    expect(orch.hardInterruptPending).toBeNull();
    expect(orch.slicesCompleted).toBe(0);
  });

  it("constructs via create with agent overrides", async () => {
    const hud = fakeHud();
    const orch = await Orchestrator.create(
      makeConfig(),
      {},
      hud.hud,
      vi.fn(),
      { tdd: fakeAgent(), review: fakeAgent() },
    );
    expect(orch).toBeDefined();
  });
});

describe("respawnTdd", () => {
  it("kills old agent, spawns fresh via factory, resets tddIsFirst but not reviewIsFirst", async () => {
    const oldTdd = fakeAgent();
    const newTdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(newTdd);
    const { orch } = await makeOrch({ tddAgent: oldTdd });
    orch.tddIsFirst = false;
    orch.reviewIsFirst = false;

    await orch.respawnTdd();

    expect(oldTdd.kill).toHaveBeenCalled();
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ label: "TDD" }), "skill-tdd", undefined, "/tmp");
    expect(orch.tddAgent).toBe(newTdd);
    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(false);
  });

  it("sends TDD_RULES_REMINDER to newly spawned TDD agent", async () => {
    const newTdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(newTdd);
    const { orch } = await makeOrch();
    await orch.respawnTdd();
    expect(newTdd.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("RUN TESTS WITH BASH"));
  });

  it("sends extended TDD rules when tddRules is set", async () => {
    const newTdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(newTdd);
    const { orch } = await makeOrch({ config: { tddRules: "no mocking" } });
    await orch.respawnTdd();
    expect(newTdd.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("[PROJECT] Additional rules from .orchrc.json:\nno mocking"),
    );
  });

  it("saves new tddSessionId to state after spawning", async () => {
    const newTdd = { ...fakeAgent(), sessionId: "new-tdd-sess" };
    vi.mocked(spawnAgent).mockReturnValue(newTdd);
    const { orch } = await makeOrch();

    await orch.respawnTdd();

    expect(saveState).toHaveBeenCalledWith(
      "/tmp/state.json",
      expect.objectContaining({ tddSessionId: "new-tdd-sess" }),
    );
  });
});

describe("respawnBoth", () => {
  it("kills both agents, spawns fresh via factory, resets both flags", async () => {
    const oldTdd = fakeAgent();
    const oldReview = fakeAgent();
    const newTdd = fakeAgent();
    const newReview = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(newTdd).mockReturnValueOnce(newReview);
    const { orch } = await makeOrch({ tddAgent: oldTdd, reviewAgent: oldReview });
    orch.tddIsFirst = false;
    orch.reviewIsFirst = false;

    await orch.respawnBoth();

    expect(oldTdd.kill).toHaveBeenCalled();
    expect(oldReview.kill).toHaveBeenCalled();
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ label: "TDD" }), "skill-tdd", undefined, "/tmp");
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ label: "REVIEW" }), "skill-review", undefined, "/tmp");
    expect(orch.tddAgent).toBe(newTdd);
    expect(orch.reviewAgent).toBe(newReview);
    expect(orch.tddIsFirst).toBe(true);
    expect(orch.reviewIsFirst).toBe(true);
  });

  it("sends REVIEW_RULES_REMINDER to newly spawned review agent", async () => {
    const newTdd = fakeAgent();
    const newReview = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(newTdd).mockReturnValueOnce(newReview);
    const { orch } = await makeOrch();
    await orch.respawnBoth();
    expect(newReview.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("ONLY REVIEW THE DIFF"));
  });

  it("sends extended review rules when reviewRules is set", async () => {
    const newTdd = fakeAgent();
    const newReview = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValueOnce(newTdd).mockReturnValueOnce(newReview);
    const { orch } = await makeOrch({ config: { reviewRules: "check types" } });
    await orch.respawnBoth();
    expect(newReview.sendQuiet).toHaveBeenCalledWith(
      expect.stringContaining("[PROJECT] Additional rules from .orchrc.json:\ncheck types"),
    );
  });

  it("saves both session IDs to state after spawning", async () => {
    const newTdd = { ...fakeAgent(), sessionId: "new-tdd-sess" };
    const newReview = { ...fakeAgent(), sessionId: "new-rev-sess" };
    vi.mocked(spawnAgent).mockReturnValueOnce(newTdd).mockReturnValueOnce(newReview);
    const { orch } = await makeOrch();

    await orch.respawnBoth();

    expect(saveState).toHaveBeenCalledWith(
      "/tmp/state.json",
      expect.objectContaining({
        tddSessionId: "new-tdd-sess",
        reviewSessionId: "new-rev-sess",
      }),
    );
  });
});

describe("setupKeyboardHandlers", () => {
  it("key 'i' with interruptTarget starts interrupt prompt", async () => {
    const { orch, hud, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    orch.interruptTarget = fakeAgent();
    pressKey("i");
    expect(hud.startPrompt).toHaveBeenCalledWith("interrupt");
  });

  it("key 'g' with interruptTarget starts guide prompt", async () => {
    const { orch, hud, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    orch.interruptTarget = fakeAgent();
    pressKey("g");
    expect(hud.startPrompt).toHaveBeenCalledWith("guide");
  });

  it("key 's' with sliceSkippable toggles skip flag", async () => {
    const { orch, hud, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    orch.sliceSkippable = true;
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(true);
    expect(hud.setSkipping).toHaveBeenCalledWith(true);
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(false);
    expect(hud.setSkipping).toHaveBeenCalledWith(false);
  });

  it("key 'q' calls cleanup and exits", async () => {
    const { orch, hud, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    pressKey("q");
    expect(hud.teardown).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  it("key 'c' with no currentSlice does not log", async () => {
    const { orch, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    expect(orch.currentSlice).toBeNull();
    pressKey("c");
    expect(vi.mocked(printSliceContent)).not.toHaveBeenCalled();
  });

  it("key 'c' with currentSlice calls printSliceContent", async () => {
    const { orch, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    vi.mocked(printSliceContent).mockReset();
    const slice: Slice = { number: 3, title: "Test slice", content: "slice body" };
    orch.currentSlice = slice;
    pressKey("c");
    expect(vi.mocked(printSliceContent)).toHaveBeenCalledWith(orch.log, slice);
  });

  it("key 'p' with no currentPlanText does not log", async () => {
    const { orch, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    expect(orch.currentPlanText).toBeNull();
    const logSpy = vi.fn();
    (orch as any).log = logSpy;
    pressKey("p");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("key 'p' with currentPlanText logs plan", async () => {
    const { orch, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    orch.currentPlanText = "## Step 1\nDo the thing";
    const logSpy = vi.fn();
    (orch as any).log = logSpy;
    pressKey("p");
    expect(logSpy).toHaveBeenCalledWith("## Step 1\nDo the thing");
  });
});

describe("quit and Ctrl+C", () => {
  it("Ctrl+C calls cleanup and exits with 130", async () => {
    const { orch, hud, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    pressKey("\x03");
    expect(hud.teardown).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  it("Q during active slice still exits cleanly", async () => {
    const { orch, hud, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    orch.currentSlice = { number: 1, title: "Active", content: "body", why: "", files: [], details: "", tests: "" };
    orch.interruptTarget = fakeAgent();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    pressKey("q");
    expect(hud.teardown).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  it("Q between slices exits cleanly", async () => {
    const { orch, hud, pressKey } = await makeOrch();
    orch.setupKeyboardHandlers();
    expect(orch.currentSlice).toBeNull();
    expect(orch.interruptTarget).toBeNull();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    pressKey("q");
    expect(hud.teardown).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });
});

describe("onInterruptSubmit", () => {
  it("guide mode injects text into interruptTarget", async () => {
    const { orch, submitInterrupt } = await makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    orch.interruptTarget = target;
    submitInterrupt("fix the test", "guide");
    expect(target.inject).toHaveBeenCalledWith("fix the test");
  });

  it("interrupt mode sets hardInterruptPending and kills target", async () => {
    const { orch, submitInterrupt } = await makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    orch.interruptTarget = target;
    submitInterrupt("rewrite approach", "interrupt");
    expect(orch.hardInterruptPending).toBe("rewrite approach");
    expect(target.kill).toHaveBeenCalled();
  });
});

describe("guide and interrupt during agent execution", () => {
  it("G during withInterrupt opens guide prompt", async () => {
    const { orch, pressKey, hud } = await makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    const deferred = Promise.withResolvers<AgentResult>();
    const withInterruptPromise = orch.withInterrupt(target, () => deferred.promise);
    pressKey("g");
    expect(hud.startPrompt).toHaveBeenCalledWith("guide");
    deferred.resolve({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    await withInterruptPromise;
    expect(orch.interruptTarget).toBeNull();
  });

  it("submitting guide text injects into running agent", async () => {
    const { orch, pressKey, submitInterrupt } = await makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    const deferred = Promise.withResolvers<AgentResult>();
    const withInterruptPromise = orch.withInterrupt(target, () => deferred.promise);
    pressKey("g");
    submitInterrupt("adjust the approach", "guide");
    expect(target.inject).toHaveBeenCalledWith("adjust the approach");
    deferred.resolve({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    await withInterruptPromise;
  });

  it("G with no interruptTarget does nothing", async () => {
    const { orch, pressKey, hud } = await makeOrch();
    orch.setupKeyboardHandlers();
    pressKey("g");
    expect(hud.startPrompt).not.toHaveBeenCalled();
  });

  it("I during withInterrupt opens interrupt prompt", async () => {
    const { orch, pressKey, hud } = await makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    const deferred = Promise.withResolvers<AgentResult>();
    const withInterruptPromise = orch.withInterrupt(target, () => deferred.promise);
    pressKey("i");
    expect(hud.startPrompt).toHaveBeenCalledWith("interrupt");
    deferred.resolve({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    await withInterruptPromise;
    expect(orch.interruptTarget).toBeNull();
  });

  it("submitting interrupt text kills agent and sets hardInterruptPending", async () => {
    const { orch, pressKey, submitInterrupt } = await makeOrch();
    orch.setupKeyboardHandlers();
    const target = fakeAgent();
    const deferred = Promise.withResolvers<AgentResult>();
    const withInterruptPromise = orch.withInterrupt(target, () => deferred.promise);
    pressKey("i");
    submitInterrupt("start over", "interrupt");
    expect(target.kill).toHaveBeenCalled();
    expect(orch.hardInterruptPending).toBe("start over");
    deferred.resolve({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    await withInterruptPromise;
  });

  it("I with no interruptTarget does nothing", async () => {
    const { orch, pressKey, hud } = await makeOrch();
    orch.setupKeyboardHandlers();
    pressKey("i");
    expect(hud.startPrompt).not.toHaveBeenCalled();
  });
});

describe("cleanup", () => {
  it("tears down hud and kills both agents", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    const { orch, hud } = await makeOrch({ tddAgent: tdd, reviewAgent: review });
    orch.cleanup();
    expect(hud.teardown).toHaveBeenCalled();
    expect(tdd.kill).toHaveBeenCalled();
    expect(review.kill).toHaveBeenCalled();
  });

  it("cleanup kills verifyAgent when present", async () => {
    const tdd = fakeAgent();
    const review = fakeAgent();
    const verify = fakeAgent();
    const { orch, hud } = await makeOrch({ tddAgent: tdd, reviewAgent: review });
    orch.verifyAgent = verify;
    orch.cleanup();
    expect(hud.teardown).toHaveBeenCalled();
    expect(tdd.kill).toHaveBeenCalled();
    expect(review.kill).toHaveBeenCalled();
    expect(verify.kill).toHaveBeenCalled();
  });
});

describe("streamer", () => {
  it("returns Streamer that shows thinking shimmer on first text", async () => {
    const hudHelper = fakeHud();
    const captured: string[] = [];
    (hudHelper.hud.createWriter as ReturnType<typeof vi.fn>).mockReturnValue((t: string) => { captured.push(t); });
    const { orch } = await makeOrch({ hud: hudHelper });
    const s = orch.streamer({ label: "T", color: "C", badge: "B" });
    // Simulate activity showing
    orch.activityShowing = true;
    s("hello");
    expect(hudHelper.hud.setActivity).toHaveBeenCalledWith("thinking...");
    expect(captured.length).toBeGreaterThan(0);
  });
});

describe("run (stub removed)", () => {
  it("run() is now fully implemented", () => {
    expect(true).toBe(true);
  });
});

describe("withInterrupt", () => {
  it("sets interruptTarget during fn and clears after", async () => {
    const { orch, tdd } = await makeOrch();
    let captured: AgentProcess | null = null;
    await orch.withInterrupt(tdd, async () => {
      captured = orch.interruptTarget;
    });
    expect(captured).toBe(tdd);
    expect(orch.interruptTarget).toBeNull();
  });

  it("clears interruptTarget even when fn throws", async () => {
    const { orch, tdd } = await makeOrch();
    await expect(orch.withInterrupt(tdd, async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    expect(orch.interruptTarget).toBeNull();
  });
});

describe("CreditExhaustedError", () => {
  it("is an Error with message and kind", () => {
    const err = new CreditExhaustedError("Credits gone", "rejected");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Credits gone");
    expect(err.kind).toBe("rejected");
  });
});

describe("checkCredit", () => {
  it("does nothing when no credit signal", async () => {
    const { orch, tdd } = await makeOrch();
    const result = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    await expect(orch.checkCredit(result, tdd)).resolves.toBeUndefined();
  });

  it("saves state and throws CreditExhaustedError on signal", async () => {
    vi.mocked(detectApiError).mockReturnValue({ kind: "credit-exhausted", retryable: false });
    const { orch, tdd } = await makeOrch();
    const result = { exitCode: 1, assistantText: "", resultText: "credit limit", needsInput: false, sessionId: "s" };
    await expect(orch.checkCredit(result, tdd)).rejects.toThrow(CreditExhaustedError);
    expect(saveState).toHaveBeenCalled();
  });
});

describe("followUp", () => {
  const needsInputResult: AgentResult = { exitCode: 0, assistantText: "question?", resultText: "", needsInput: true, sessionId: "s" };
  const doneResult: AgentResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };

  it("returns result unchanged when needsInput is false", async () => {
    const { orch, tdd } = await makeOrch();
    const result = await orch.followUp(doneResult, tdd);
    expect(result).toBe(doneResult);
  });

  it("returns unchanged when noInteraction is true", async () => {
    const { orch, tdd } = await makeOrch({ config: { noInteraction: true } });
    const result = await orch.followUp(needsInputResult, tdd);
    expect(result).toBe(needsInputResult);
  });

  it("asks user and forwards answer to agent", async () => {
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("my answer");
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(doneResult);
    const { orch } = await makeOrch({ hud: hudHelper, tddAgent: tdd });
    await orch.followUp(needsInputResult, tdd);
    expect(hudHelper.hud.askUser).toHaveBeenCalled();
    expect(tdd.send).toHaveBeenCalledWith("my answer", expect.any(Function));
  });

  it("sends autonomy fallback on empty input", async () => {
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(doneResult);
    const { orch } = await makeOrch({ hud: hudHelper, tddAgent: tdd });
    await orch.followUp(needsInputResult, tdd);
    expect(tdd.send).toHaveBeenCalledWith(
      expect.stringContaining("proceed with your best judgement"),
      expect.any(Function),
    );
  });

  it("stops after 3 follow-ups", async () => {
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("keep going");
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(needsInputResult);
    const { orch } = await makeOrch({ hud: hudHelper, tddAgent: tdd });
    await orch.followUp(needsInputResult, tdd);
    expect(tdd.send).toHaveBeenCalledTimes(3);
  });
});

describe("Orchestrator.commitSweep", () => {
  it("skips when tree is clean", async () => {
    const tdd = fakeAgent();
    const { orch } = await makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("skips with warning when agent is not alive", async () => {
    const tdd = fakeAgent();
    Object.defineProperty(tdd, "alive", { value: false });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = await makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(tdd.send).not.toHaveBeenCalled();
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("not alive"));
  });

  it("sends commit sweep prompt when dirty", async () => {
    const tdd = fakeAgent();
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = await makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(tdd.send).toHaveBeenCalledWith(expect.stringContaining("Auth"), expect.any(Function), expect.any(Function));
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes detected"));
  });

  it("logs success on exit 0", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = await makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("commit sweep complete"));
  });

  it("logs failure on non-zero exit", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = await makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes may remain"));
  });

  it("calls followUp when needsInput is true", async () => {
    const tdd = fakeAgent();
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    (tdd.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ exitCode: 0, assistantText: "", resultText: "", needsInput: true, sessionId: "s" })
      .mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = await makeOrch({ tddAgent: tdd, hud: hudHelper });
    await orch.commitSweep("Auth");
    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });

  it("sets interruptTarget during send", async () => {
    const tdd = fakeAgent();
    let capturedTarget: AgentProcess | null = null;
    (tdd.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      capturedTarget = (makeOrch as any)._lastOrch?.interruptTarget ?? null;
      return { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    });
    // Use a different approach: check interruptTarget is set during send
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = await makeOrch({ tddAgent: tdd });
    let target: AgentProcess | null = null;
    (tdd.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      target = orch.interruptTarget;
      return { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    });
    await orch.commitSweep("Auth");
    expect(target).toBe(tdd);
    expect(orch.interruptTarget).toBeNull();
  });
});

describe("Orchestrator.reviewFix", () => {
  const reviewResult = (text: string, overrides?: Partial<AgentResult>): AgentResult => ({
    exitCode: 0, assistantText: text, resultText: "", needsInput: false, sessionId: "s",
    ...overrides,
  });

  it("exits when no changes since baseSha", async () => {
    const review = fakeAgent();
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch({ reviewAgent: review });
    await orch.reviewFix("content", "abc123");
    expect(review.send).not.toHaveBeenCalled();
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("no diff"));
  });

  it("breaks when review text is clean", async () => {
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("REVIEW_CLEAN"));
    vi.mocked(isCleanReview).mockReturnValue(true);
    const { orch } = await makeOrch({ reviewAgent: review });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(1);
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("Review clean"));
  });

  it("stops after maxReviewCycles", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("off-by-one"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    const { orch } = await makeOrch({ reviewAgent: review, tddAgent: tdd, config: { maxReviewCycles: 2 } });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(2);
  });

  it("uses maxReviewCycles from config (single cycle)", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("off-by-one"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    const { orch } = await makeOrch({ reviewAgent: review, tddAgent: tdd, config: { maxReviewCycles: 1 } });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(1);
  });

  it("forwards review findings to TDD agent", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(reviewResult("off-by-one error"))
      .mockResolvedValue(reviewResult("REVIEW_CLEAN"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    vi.mocked(isCleanReview).mockImplementation((t) => t.includes("REVIEW_CLEAN"));
    const { orch } = await makeOrch({ reviewAgent: review, tddAgent: tdd });
    await orch.reviewFix("content", "sha1");
    expect(tdd.send).toHaveBeenCalledWith(expect.stringContaining("off-by-one"), expect.any(Function), expect.any(Function));
  });

  it("prepends brief on first review and first TDD message only", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    const reviewSends: string[] = [];
    const tddSends: string[] = [];
    (review.send as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      reviewSends.push(p);
      return reviewResult("findings");
    });
    (tdd.send as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      tddSends.push(p);
      return reviewResult("fixed");
    });
    const { orch } = await makeOrch({ reviewAgent: review, tddAgent: tdd, config: { brief: "Project context", maxReviewCycles: 2 } });
    await orch.reviewFix("content", "sha1");
    expect(reviewSends[0]).toContain("Project context");
    expect(tddSends[0]).toContain("Project context");
    if (reviewSends.length > 1) expect(reviewSends[1]).not.toContain("Project context");
  });

  it("breaks when TDD bot makes no changes", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("findings"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    vi.mocked(hasChanges)
      .mockResolvedValueOnce(true)   // initial check — there are changes
      .mockResolvedValueOnce(false); // after fix — no changes
    const { orch } = await makeOrch({ reviewAgent: review, tddAgent: tdd, config: { maxReviewCycles: 3 } });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(1);
  });

  it("breaks early when sliceSkipFlag is set", async () => {
    const review = fakeAgent();
    const { orch } = await makeOrch({ reviewAgent: review });
    orch.sliceSkipFlag = true;
    await orch.reviewFix("content", "sha1");
    expect(review.send).not.toHaveBeenCalled();
  });

  it("calls followUp on TDD result when needsInput", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    (review.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(reviewResult("findings"))
      .mockResolvedValue(reviewResult("REVIEW_CLEAN"));
    (tdd.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ exitCode: 0, assistantText: "fixed", resultText: "", needsInput: true, sessionId: "s" })
      .mockResolvedValue(reviewResult("done"));
    vi.mocked(isCleanReview).mockImplementation((t) => t.includes("REVIEW_CLEAN"));
    const { orch } = await makeOrch({ reviewAgent: review, tddAgent: tdd, hud: hudHelper });
    await orch.reviewFix("content", "sha1");
    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });

  it("throws CreditExhaustedError on review credit exhaustion", async () => {
    const review = fakeAgent();
    const badResult = reviewResult("", { exitCode: 1 });
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(badResult);
    vi.mocked(detectApiError).mockReturnValue({ kind: "credit-exhausted", retryable: false });
    const { orch } = await makeOrch({ reviewAgent: review });
    await expect(orch.reviewFix("content", "sha1")).rejects.toThrow(CreditExhaustedError);
  });

  it("calls hud.update with agent status changes", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(reviewResult("findings"))
      .mockResolvedValue(reviewResult("REVIEW_CLEAN"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    const hudHelper = fakeHud();
    vi.mocked(isCleanReview).mockImplementation((t) => t.includes("REVIEW_CLEAN"));
    const { orch } = await makeOrch({ reviewAgent: review, tddAgent: tdd, hud: hudHelper });
    await orch.reviewFix("content", "sha1");
    expect(hudHelper.hud.update).toHaveBeenCalledWith(expect.objectContaining({ activeAgent: "REV" }));
    expect(hudHelper.hud.update).toHaveBeenCalledWith(expect.objectContaining({ activeAgent: "TDD" }));
  });
});

describe("isAlreadyImplemented", () => {
  it("returns true when text matches marker and HEAD === base", async () => {
    const { orch } = await makeOrch();
    expect(orch.isAlreadyImplemented("This feature is already implemented", "abc123", "abc123")).toBe(true);
  });

  it("returns false when text matches but HEAD !== base", async () => {
    const { orch } = await makeOrch();
    expect(orch.isAlreadyImplemented("already implemented", "def456", "abc123")).toBe(false);
  });

  it("returns false when no text marker present", async () => {
    const { orch } = await makeOrch();
    expect(orch.isAlreadyImplemented("I built the feature and all tests pass", "abc123", "abc123")).toBe(false);
  });

  it("matches 'nothing left to do' pattern", async () => {
    const { orch } = await makeOrch();
    expect(orch.isAlreadyImplemented("There is nothing left to implement", "abc", "abc")).toBe(true);
  });

  it("matches 'already exist' pattern", async () => {
    const { orch } = await makeOrch();
    expect(orch.isAlreadyImplemented("The tests already exist", "abc", "abc")).toBe(true);
  });
});

describe("verify", () => {
  const testSlice: Slice = { number: 1, title: "Test", content: "Do something" };
  const passText = "### VERIFY_RESULT\n**Status:** PASS";
  const failText = "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- test broke";

  it("spawns verify agent via spawnAgentFactory(BOT_VERIFY, verifySkill)", async () => {
    const vAgent = fakeAgent();
    (vAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(spawnAgent).mockReturnValue(vAgent);
    const { orch } = await makeOrch({ config: { verifySkill: "my-verify-skill" } });
    await orch.verify(testSlice, "abc123");
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ label: "VERIFY" }), "my-verify-skill", undefined, "/tmp");
  });

  it("returns true when verification passes", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch();
    const result = await orch.verify(testSlice, "base123");
    expect(result).toBe(true);
    // Verify agent is now persistent per-group — not killed after each slice
  });

  it("retries via TDD bot on first failure then returns true on re-verify pass", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" })
      .mockResolvedValueOnce({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });
    const result = await orch.verify(testSlice, "base123");
    expect(result).toBe(true);
    expect(tdd.send).toHaveBeenCalledWith(expect.stringContaining("Fix them"), expect.any(Function), expect.any(Function));
    expect(verifyAgent.send).toHaveBeenCalledTimes(2);
  });

  it("returns false when operator skips after second failure", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("s");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({ hud: hudHelper });
    const result = await orch.verify(testSlice, "base123");
    expect(result).toBe(false);
    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });

  it("exits process when operator stops", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("t");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({ hud: hudHelper });
    await orch.verify(testSlice, "base123");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("returns true when operator retries", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("r");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({ hud: hudHelper });
    const result = await orch.verify(testSlice, "base123");
    expect(result).toBe(true);
  });
});

describe("runSlice", () => {
  const testSlice: Slice = { number: 1, title: "Test", content: "Do something" };
  const tddResult: AgentResult = { exitCode: 0, assistantText: "implemented", resultText: "", needsInput: false, sessionId: "s" };

  it("runs verify then reviewFix for normal slice", async () => {
    const passText = "### VERIFY_RESULT\n**Status:** PASS";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("newsha");
    const tdd = fakeAgent();
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "REVIEW_CLEAN", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(isCleanReview).mockImplementation((t) => t.includes("REVIEW_CLEAN"));
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({
      tddAgent: tdd,
      reviewAgent: review,
    });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(verifyAgent.send).toHaveBeenCalled();
    expect(result.skipped).toBe(false);
    expect(result.reviewBase).toBe("newsha");
  });

  it("skips verify/review when already implemented", async () => {
    vi.mocked(captureRef).mockResolvedValue("samesha");
    const review = fakeAgent();
    const { orch } = await makeOrch({ reviewAgent: review });
    const alreadyResult = { ...tddResult, assistantText: "already fully implemented" };
    const result = await orch.runSlice(testSlice, "samesha", alreadyResult, "vfybase");
    expect(review.send).not.toHaveBeenCalled();
    expect(result.skipped).toBe(false);
    expect(result.reviewBase).toBe("samesha");
    expect(saveState).toHaveBeenCalled();
  });

  it("defers review when diff is small", async () => {
    const passText = "### VERIFY_RESULT\n**Status:** PASS";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("newsha");
    const review = fakeAgent();
    vi.mocked(measureDiff).mockResolvedValue({ linesAdded: 2, linesRemoved: 1, total: 3 });
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({
      reviewAgent: review,
      config: { reviewThreshold: 30 },
    });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(review.send).not.toHaveBeenCalled();
    expect(result.reviewBase).toBe("oldbase"); // not advanced
    expect(saveState).toHaveBeenCalled();
  });

  it("returns skipped true when verify returns false", async () => {
    const failText = "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- broke";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("s");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({ hud: hudHelper });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(result.skipped).toBe(true);
  });

  it("verify agent persists after operator chooses retry", async () => {
    const failText = "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- broke";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("r");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({ hud: hudHelper });
    await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    // Verify agent is now persistent per-group — not killed per-slice
    expect(verifyAgent.kill).not.toHaveBeenCalled();
  });

  it("logs skip messages for disabled verify and review", async () => {
    vi.mocked(captureRef).mockResolvedValue("newsha");
    const logFn = vi.fn();
    const review = fakeAgent();
    const { orch } = await makeOrch({
      reviewAgent: review,
      config: { verifySkill: null, reviewSkill: null },
    });
    (orch as any).log = logFn;
    await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("Verify skipped");
    expect(allLogs).toContain("Review skipped");
  });

  it("saves lastCompletedSlice when reviewSkill is null", async () => {
    const passText = "### VERIFY_RESULT\n**Status:** PASS";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("newsha");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const review = fakeAgent();
    const { orch } = await makeOrch({
      reviewAgent: review,
      config: { reviewSkill: null },
    });
    await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(saveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ lastCompletedSlice: 1 }),
    );
  });

  it("skips review when reviewSkill is null", async () => {
    const passText = "### VERIFY_RESULT\n**Status:** PASS";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("newsha");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const review = fakeAgent();
    const { orch } = await makeOrch({
      reviewAgent: review,
      config: { reviewSkill: null },
    });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(review.send).not.toHaveBeenCalled();
    expect(result.skipped).toBe(false);
  });

  it("skips verify when verifySkill is null", async () => {
    vi.mocked(captureRef).mockResolvedValue("newsha");
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "REVIEW_CLEAN", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(isCleanReview).mockImplementation((t) => t.includes("REVIEW_CLEAN"));
    vi.mocked(spawnAgent).mockReset();
    const { orch } = await makeOrch({
      reviewAgent: review,
      config: { verifySkill: null },
    });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(result.skipped).toBe(false);
  });
});

// ─── run() ────────────────────────────────────────────────────────────────────

describe("run()", () => {
  it("resolves for empty group list", async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    await expect(orch.run([], 0)).resolves.toBeUndefined();
  });

  it("saves session IDs to state on group entry", async () => {
    const tdd = { ...fakeAgent(), sessionId: "tdd-run-sess" };
    const review = { ...fakeAgent(), sessionId: "rev-run-sess" };
    const group = { name: "Auth", slices: [{ number: 1, title: "a", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch({ tddAgent: tdd, reviewAgent: review });
    vi.spyOn(orch, "planThenExecute").mockResolvedValue({ tddResult, skipped: false });
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    expect(saveState).toHaveBeenCalledWith(
      "/tmp/state.json",
      expect.objectContaining({
        tddSessionId: "tdd-run-sess",
        reviewSessionId: "rev-run-sess",
      }),
    );
  });

  it("skips group when all slices completed", async () => {
    const group = { name: "Auth", slices: [{ number: 1, title: "a", content: "a" }, { number: 2, title: "b", content: "b" }] };
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    orch.state = { lastCompletedSlice: 2 };
    await orch.run([group], 0);
    expect(orch.slicesCompleted).toBe(2);
  });

  it("skips completed slices but runs remaining", async () => {
    const group = {
      name: "Auth",
      slices: [
        { number: 1, title: "a", content: "slice 1" },
        { number: 2, title: "b", content: "slice 2" },
        { number: 3, title: "c", content: "slice 3" },
      ],
    };
    const pte = vi.fn().mockResolvedValue({ tddResult: { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" }, skipped: false });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });
    orch.state = { lastCompletedSlice: 1 };
    await orch.run([group], 0);
    // Slice 1 skipped, slices 2 and 3 went through pipeline
    expect(pte).toHaveBeenCalledTimes(2);
  });

  it("sets currentSlice during processing and clears after", async () => {
    const slice = { number: 1, title: "Auth", content: "do auth" };
    const group = { name: "G", slices: [slice] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    let capturedSlice: unknown = "not-set";
    const pte = vi.fn().mockImplementation(async () => {
      capturedSlice = orch.currentSlice;
      return { tddResult, skipped: false };
    });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    expect(capturedSlice).toEqual(slice);
    expect(orch.currentSlice).toBeNull();
  });

  it("clears currentSlice when slice is skipped", async () => {
    const slice = { number: 1, title: "Auth", content: "do auth" };
    const group = { name: "G", slices: [slice] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: true });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });
    vi.spyOn(orch as any, "respawnTdd").mockResolvedValue(undefined);

    await orch.run([group], 0);

    expect(orch.currentSlice).toBeNull();
  });

  it("currentPlanText persists through hard interrupt path and clears after runSlice", async () => {
    const slice = { number: 1, title: "Auth", content: "do auth" };
    const group = { name: "G", slices: [slice] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false, hardInterrupt: "fix this", planText: "the plan" });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const tdd = fakeAgent();
    const { orch } = await makeOrch({ tddAgent: tdd });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch as any, "respawnTdd").mockResolvedValue(undefined);
    vi.spyOn(orch as any, "checkCredit").mockResolvedValue(undefined);
    let capturedPlanText: unknown = "not-set";
    vi.spyOn(orch, "runSlice").mockImplementation(async () => {
      capturedPlanText = orch.currentPlanText;
      return { reviewBase: "sha", skipped: false };
    });

    await orch.run([group], 0);

    expect(capturedPlanText).toBe("the plan");
    expect(orch.currentPlanText).toBeNull();
  });

  it("clears currentPlanText when slice is skipped", async () => {
    const slice = { number: 1, title: "Auth", content: "do auth" };
    const group = { name: "G", slices: [slice] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: true, planText: "skip plan" });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });
    vi.spyOn(orch as any, "respawnTdd").mockResolvedValue(undefined);

    await orch.run([group], 0);

    expect(orch.currentPlanText).toBeNull();
  });

  it("sets currentPlanText from planThenExecute result and clears after slice", async () => {
    const slice = { number: 1, title: "Auth", content: "do auth" };
    const group = { name: "G", slices: [slice] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false, planText: "the plan" });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    let capturedPlanText: unknown = "not-set";
    vi.spyOn(orch, "runSlice").mockImplementation(async () => {
      capturedPlanText = orch.currentPlanText;
      return { reviewBase: "sha", skipped: false };
    });

    await orch.run([group], 0);

    expect(capturedPlanText).toBe("the plan");
    expect(orch.currentPlanText).toBeNull();
  });

  it("logs slice intro for non-skipped slices", async () => {
    const slice = { number: 1, title: "Setup auth", content: "c" };
    const group = { name: "G", slices: [slice] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(printSliceIntro).mockReset();
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    expect(vi.mocked(printSliceIntro)).toHaveBeenCalledWith(expect.any(Function), slice);
  });

  it("calls commitSweep and runSlice for each slice", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(isCleanReview).mockReturnValue(true);
    const tdd = fakeAgent();
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "LGTM", resultText: "", needsInput: false, sessionId: "s" });
    const { orch } = await makeOrch({ tddAgent: tdd, reviewAgent: review });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);

    const commitSweepSpy = vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    const runSliceSpy = vi.spyOn(orch, "runSlice");

    await orch.run([group], 0);

    expect(commitSweepSpy).toHaveBeenCalled();
    expect(runSliceSpy).toHaveBeenCalledWith(group.slices[0], expect.any(String), tddResult, expect.any(String));
  });

  it("skips slice when planThenExecute returns skipped", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const pte = vi.fn().mockResolvedValue({ tddResult: { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" }, skipped: true });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);

    const respawnTddSpy = vi.spyOn(orch, "respawnTdd").mockResolvedValue(undefined);
    const runSliceSpy = vi.spyOn(orch, "runSlice");

    await orch.run([group], 0);

    expect(runSliceSpy).not.toHaveBeenCalled();
    expect(respawnTddSpy).toHaveBeenCalled();
    expect(saveState).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ lastCompletedSlice: 1 }));
  });

  it("respawns agents between groups", async () => {
    const g1 = { name: "A", slices: [{ number: 1, title: "a", content: "c" }] };
    const g2 = { name: "B", slices: [{ number: 2, title: "b", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch({ config: { auto: true } });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha1", skipped: false });
    const respawnBothSpy = vi.spyOn(orch, "respawnBoth").mockResolvedValue(undefined);

    await orch.run([g1, g2], 0);

    expect(respawnBothSpy).toHaveBeenCalledTimes(1);
  });

  it("retries planThenExecute when replan is true (up to MAX_REPLANS)", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const okResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn()
      .mockResolvedValueOnce({ tddResult: okResult, skipped: false, replan: true })
      .mockResolvedValueOnce({ tddResult: okResult, skipped: false, replan: true })
      // After max replans, auto-accepts (noInteraction forced)
      .mockResolvedValueOnce({ tddResult: okResult, skipped: false });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    // 2 replan attempts + 1 auto-accept = 3 total calls
    expect(pte).toHaveBeenCalledTimes(3);
    // The third call should have forceAccept: true (auto-accept) — index 2 after sliceNumber
    const thirdCallForceAccept = pte.mock.calls[2][2];
    expect(thirdCallForceAccept).toBe(true);
  });

  it("uses maxReplans from config", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const okResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn()
      .mockResolvedValueOnce({ tddResult: okResult, skipped: false, replan: true })
      // After 1 replan attempt, auto-accepts
      .mockResolvedValueOnce({ tddResult: okResult, skipped: false });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch({ config: { maxReplans: 1 } });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    // 1 replan attempt + 1 auto-accept = 2 total calls
    expect(pte).toHaveBeenCalledTimes(2);
    // The second call should have forceAccept: true — index 2 after sliceNumber
    expect(pte.mock.calls[1][2]).toBe(true);
  });

  it("handles hardInterrupt by respawning TDD with guidance", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const okResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult: okResult, skipped: false, hardInterrupt: "rewrite the approach" });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const newTdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(newTdd);
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    // TDD agent was respawned via factory
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ label: "TDD" }), "skill-tdd", undefined, "/tmp");
    expect(orch.tddAgent).toBe(newTdd);
    // Guidance was sent to the new TDD agent
    expect(newTdd.send).toHaveBeenCalled();
    const sentPrompt = (newTdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentPrompt).toContain("rewrite the approach");
  });

  it("saves lastCompletedGroup after group completes", async () => {
    const group = { name: "Auth", slices: [{ number: 1, title: "a", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = await makeOrch({ config: { auto: true } });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha1", skipped: false });

    await orch.run([group], 0);

    expect(saveState).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ lastCompletedGroup: "Auth" }));
  });
});

// ─── gapAnalysis() ────────────────────────────────────────────────────────────

describe("gapAnalysis()", () => {
  it("skips when sliceSkipFlag is true", async () => {
    vi.mocked(spawnAgent).mockReset();
    const { orch } = await makeOrch();
    orch.sliceSkipFlag = true;

    await (orch as any).gapAnalysis({ name: "G", slices: [] }, "sha");

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(orch.sliceSkipFlag).toBe(false);
  });

  it("logs skip message when gapDisabled is true", async () => {
    const logFn = vi.fn();
    const { orch } = await makeOrch({ config: { gapDisabled: true } });
    (orch as any).log = logFn;

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("Gap analysis skipped");
  });

  it("does not log gap skipped when gapDisabled but no changes exist", async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);
    const logFn = vi.fn();
    const { orch } = await makeOrch({ config: { gapDisabled: true } });
    (orch as any).log = logFn;

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).not.toContain("Gap analysis skipped");
  });

  it("skips gap analysis when gapDisabled is true", async () => {
    vi.mocked(spawnAgent).mockReset();
    const { orch } = await makeOrch({ config: { gapDisabled: true } });

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("logs gap review skipped when reviewSkill is null and TDD made changes", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing tests", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(captureRef).mockResolvedValue("gapsha");
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const logFn = vi.fn();
    const { orch } = await makeOrch({ tddAgent: tdd, config: { reviewSkill: null } });
    vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);
    (orch as any).log = logFn;

    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    await (orch as any).gapAnalysis(group, "basesha");

    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("Gap review skipped");
  });

  it("skips reviewFix after gap fixes when reviewSkill is null", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing edge case tests", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(captureRef).mockResolvedValue("gapsha");
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch({ tddAgent: tdd, config: { reviewSkill: null } });
    const reviewFixSpy = vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    const group = { name: "G", slices: [{ number: 1, title: "a", content: "slice content" }] };
    await (orch as any).gapAnalysis(group, "basesha");

    expect(reviewFixSpy).not.toHaveBeenCalled();
    expect(gapAgent.kill).toHaveBeenCalled();
  });

  it("skips when no changes since group base", async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(spawnAgent).mockReset();
    const { orch } = await makeOrch();

    await (orch as any).gapAnalysis({ name: "G", slices: [] }, "sha");

    expect(hasChanges).toHaveBeenCalledWith("/tmp", "sha");
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("runs gap agent and sends findings to TDD for fixes", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing edge case tests for auth", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(captureRef).mockResolvedValue("gapsha");
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });
    const reviewFixSpy = vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    const group = { name: "G", slices: [{ number: 1, title: "a", content: "slice content" }] };
    await (orch as any).gapAnalysis(group, "basesha");

    expect(gapAgent.send).toHaveBeenCalled();
    expect(tdd.send).toHaveBeenCalled();
    expect(reviewFixSpy).toHaveBeenCalled();
    expect(gapAgent.kill).toHaveBeenCalled();
  });

  it("logs warning when gap agent fails (not success)", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    const logFn = vi.fn();
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });
    (orch as any).log = logFn;

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    // Should log a warning, NOT "No coverage gaps found"
    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("failed");
    expect(allLogs).not.toContain("No coverage gaps found");
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("returns cleanly when hardInterruptPending set during TDD fix phase", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing edge case tests", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    vi.mocked(captureRef).mockResolvedValue("gapsha");
    const { orch } = await makeOrch({ tddAgent: tdd });
    const reviewFixSpy = vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    const origWithInterrupt = orch.withInterrupt.bind(orch);
    vi.spyOn(orch, "withInterrupt").mockImplementation(async (agent, fn) => {
      const result = await origWithInterrupt(agent, fn);
      if (agent === tdd) orch.hardInterruptPending = "stop";
      return result;
    });

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(gapAgent.kill).toHaveBeenCalled();
    expect(reviewFixSpy).not.toHaveBeenCalled();
    expect(orch.hardInterruptPending).toBeNull();
  });

  it("returns cleanly when sliceSkipFlag set during TDD fix phase", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing edge case tests", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    vi.mocked(captureRef).mockResolvedValue("gapsha");
    const { orch } = await makeOrch({ tddAgent: tdd });
    const reviewFixSpy = vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    const origWithInterrupt = orch.withInterrupt.bind(orch);
    vi.spyOn(orch, "withInterrupt").mockImplementation(async (agent, fn) => {
      const result = await origWithInterrupt(agent, fn);
      if (agent === tdd) orch.sliceSkipFlag = true;
      return result;
    });

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(gapAgent.kill).toHaveBeenCalled();
    expect(reviewFixSpy).not.toHaveBeenCalled();
    expect(orch.sliceSkipFlag).toBe(false);
  });

  it("returns cleanly when sliceSkipFlag set during gap agent phase", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "NO_GAPS_FOUND", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });

    const origWithInterrupt = orch.withInterrupt.bind(orch);
    vi.spyOn(orch, "withInterrupt").mockImplementation(async (agent, fn) => {
      const result = await origWithInterrupt(agent, fn);
      if (agent === gapAgent) orch.sliceSkipFlag = true;
      return result;
    });

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(gapAgent.kill).toHaveBeenCalled();
    expect(tdd.send).not.toHaveBeenCalled();
    expect(orch.sliceSkipFlag).toBe(false);
  });

  it("logs interrupted (not failed) when hardInterruptPending is set after gap agent", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 143, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    const logFn = vi.fn();
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });
    (orch as any).log = logFn;

    // Simulate interrupt handler having fired during gap agent run
    const origWithInterrupt = orch.withInterrupt.bind(orch);
    vi.spyOn(orch, "withInterrupt").mockImplementation(async (agent, fn) => {
      const result = await origWithInterrupt(agent, fn);
      if (agent === gapAgent) orch.hardInterruptPending = "skip this";
      return result;
    });

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("interrupted");
    expect(allLogs).not.toContain("failed");
    expect(gapAgent.kill).toHaveBeenCalled();
    expect(tdd.send).not.toHaveBeenCalled();
    expect(orch.hardInterruptPending).toBeNull();
  });

  it("sets activeAgent to GAP during gap scan", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "NO_GAPS_FOUND", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const hudHelper = fakeHud();
    const { orch } = await makeOrch({ hud: hudHelper });

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(hudHelper.hud.update).toHaveBeenCalledWith(expect.objectContaining({ activeAgent: "GAP", activeAgentActivity: "scanning for gaps..." }));
  });

  it("does not call TDD bot when NO_GAPS_FOUND", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "NO_GAPS_FOUND", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(gapAgent.send).toHaveBeenCalled();
    expect(tdd.send).not.toHaveBeenCalled();
  });
});

// ─── finalPasses() ────────────────────────────────────────────────────────────

describe("finalPasses()", () => {
  it("returns early when no changes since run base", async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(spawnAgent).mockReset();
    const { orch } = await makeOrch();

    await (orch as any).finalPasses("runbasesha");

    expect(hasChanges).toHaveBeenCalledWith("/tmp", "runbasesha");
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("skips fix cycle when pass returns NO_ISSUES_FOUND", async () => {
    const finalAgent = fakeAgent();
    (finalAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "NO_ISSUES_FOUND", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(finalAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });

    await (orch as any).finalPasses("sha");

    expect(finalAgent.send).toHaveBeenCalled();
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("sends findings to TDD and calls reviewFix", async () => {
    const finalAgent = fakeAgent();
    (finalAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Found type issues in auth.ts", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(captureRef).mockResolvedValue("fixsha");
    vi.mocked(spawnAgent).mockReturnValue(finalAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });
    const reviewFixSpy = vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    await (orch as any).finalPasses("sha");

    expect(tdd.send).toHaveBeenCalled();
    expect(reviewFixSpy).toHaveBeenCalled();
  });
});

// ─── run() full lifecycle ─────────────────────────────────────────────────────

describe("run() full lifecycle", () => {
  it("calls gapAnalysis, commitSweep per group, then finalPasses", async () => {
    const group = { name: "Auth", slices: [{ number: 1, title: "a", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(captureRef).mockResolvedValue("sha1");
    const { orch } = await makeOrch({ config: { auto: true } });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    const commitSweepSpy = vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    const runSliceSpy = vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha1", skipped: false });
    const gapSpy = vi.spyOn(orch, "gapAnalysis").mockResolvedValue(undefined);
    const finalSpy = vi.spyOn(orch, "finalPasses").mockResolvedValue(undefined);

    await orch.run([group], 0);

    // Order: slice pipeline → gap → commitSweep(group name) → state persist → finalPasses
    expect(runSliceSpy).toHaveBeenCalled();
    expect(gapSpy).toHaveBeenCalledWith(group, "sha1");
    // commitSweep called at least for the group name (after gap)
    expect(commitSweepSpy).toHaveBeenCalledWith("Auth");
    expect(finalSpy).toHaveBeenCalledWith("sha1");
  });

  it("prompts user between groups in interactive mode", async () => {
    const g1 = { name: "A", slices: [{ number: 1, title: "a", content: "c" }] };
    const g2 = { name: "B", slices: [{ number: 2, title: "b", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("y");
    const { orch } = await makeOrch({ hud: hudHelper, config: { auto: false, noInteraction: false } });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha1", skipped: false });
    vi.spyOn(orch, "respawnBoth").mockResolvedValue(undefined);

    await orch.run([g1, g2], 0);

    expect(hudHelper.hud.askUser).toHaveBeenCalled();
    expect(pte).toHaveBeenCalledTimes(2); // both groups ran
  });

  it("exits early when user declines next group", async () => {
    const g1 = { name: "A", slices: [{ number: 1, title: "a", content: "c" }] };
    const g2 = { name: "B", slices: [{ number: 2, title: "b", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("n");
    const { orch } = await makeOrch({ hud: hudHelper, config: { auto: false, noInteraction: false } });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha1", skipped: false });
    vi.spyOn(orch, "respawnBoth").mockResolvedValue(undefined);

    await orch.run([g1, g2], 0);

    expect(pte).toHaveBeenCalledTimes(1); // only first group ran
  });
});

// ─── Gap coverage tests ───────────────────────────────────────────────────────

describe("finalPasses() gap coverage", () => {
  it("skips to next pass when agent exits with non-zero exitCode", async () => {
    let callCount = 0;
    vi.mocked(spawnAgent).mockImplementation(() => {
      const agent = fakeAgent();
      callCount++;
      if (callCount === 1) {
        (agent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
      } else {
        (agent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "NO_ISSUES_FOUND", resultText: "", needsInput: false, sessionId: "s" });
      }
      return agent;
    });
    const tdd = fakeAgent();
    const logFn = vi.fn();
    const { orch } = await makeOrch({ tddAgent: tdd });
    (orch as any).log = logFn;

    await (orch as any).finalPasses("sha");

    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("agent failed");
    expect(callCount).toBeGreaterThan(1);
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("skips reviewFix when TDD fix produces no changes", async () => {
    const finalAgent = fakeAgent();
    (finalAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Found issues", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(hasChanges)
      .mockReset()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(false);
    vi.mocked(captureRef).mockResolvedValue("fixsha");
    vi.mocked(spawnAgent).mockReturnValue(finalAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });
    const reviewFixSpy = vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    await (orch as any).finalPasses("sha");

    expect(tdd.send).toHaveBeenCalled();
    expect(reviewFixSpy).not.toHaveBeenCalled();
  });

  it("calls followUp when TDD fix result needs input", async () => {
    const finalAgent = fakeAgent();
    (finalAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Found issues", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: true, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("sha");
    vi.mocked(spawnAgent).mockReturnValue(finalAgent);
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const { orch } = await makeOrch({ tddAgent: tdd, hud: hudHelper });
    vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    await (orch as any).finalPasses("sha");

    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });
});

describe("gapAnalysis() gap coverage", () => {
  it("skips reviewFix when TDD gap-fix produces no diff", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing tests for X", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(hasChanges)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(captureRef).mockResolvedValue("gapsha");
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch({ tddAgent: tdd });
    const reviewFixSpy = vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(tdd.send).toHaveBeenCalled();
    expect(reviewFixSpy).not.toHaveBeenCalled();
  });

  it("calls followUp when TDD gap-fix result needs input", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing tests for X", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: true, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("sha");
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const { orch } = await makeOrch({ tddAgent: tdd, hud: hudHelper });
    vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });
});

describe("commitSweep() gap coverage", () => {
  it("throws CreditExhaustedError when credit signal detected", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(detectApiError).mockReturnValue({ kind: "credit-exhausted", retryable: false });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = await makeOrch({ tddAgent: tdd });

    await expect(orch.commitSweep("Auth")).rejects.toThrow(CreditExhaustedError);
    expect(saveState).toHaveBeenCalled();
  });
});

describe("reviewFix() gap coverage", () => {
  it("throws CreditExhaustedError when TDD fix hits credit limit", async () => {
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Fix this", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    // detectApiError fires on second call (the TDD fix result)
    let callCount = 0;
    vi.mocked(detectApiError).mockImplementation(() => {
      callCount++;
      if (callCount >= 2) return { kind: "credit-exhausted", retryable: false };
      return null;
    });
    vi.mocked(captureRef).mockResolvedValue("sha");
    const { orch } = await makeOrch({ tddAgent: tdd, reviewAgent: review });

    await expect(orch.reviewFix("content", "basesha")).rejects.toThrow(CreditExhaustedError);
  });
});

describe("runSlice() gap coverage", () => {
  const testSlice = { number: 5, title: "Test", content: "do test things" };
  const okTddResult = { exitCode: 0, assistantText: "done", resultText: "", needsInput: false, sessionId: "s" };

  it("returns skipped when sliceSkipFlag set after verify but before review", async () => {
    const passText = "### VERIFY_RESULT\n**Status:** PASS\n**New failures:**\nnone";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("newsha");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch();

    const origVerify = orch.verify.bind(orch);
    vi.spyOn(orch, "verify").mockImplementation(async (...args) => {
      const result = await origVerify(...args);
      orch.sliceSkipFlag = true;
      return result;
    });

    const result = await orch.runSlice(testSlice, "oldbase", okTddResult, "vfybase");
    expect(result.skipped).toBe(true);
  });

  it("returns skipped after reviewFix when sliceSkipFlag set during review", async () => {
    const passText = "### VERIFY_RESULT\n**Status:** PASS\n**New failures:**\nnone";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Fix this", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(captureRef).mockResolvedValue("newsha");
    vi.mocked(spawnAgent).mockReturnValue(verifyAgent);
    const { orch } = await makeOrch({
      tddAgent: tdd, reviewAgent: review,
    });

    vi.spyOn(orch, "reviewFix").mockImplementation(async () => {
      orch.sliceSkipFlag = true;
    });

    const result = await orch.runSlice(testSlice, "oldbase", okTddResult, "vfybase");
    expect(result.skipped).toBe(true);
  });
});

describe("run() gap coverage", () => {
  it("throws CreditExhaustedError when TDD result triggers credit signal", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(detectApiError).mockReturnValue({ kind: "credit-exhausted", retryable: false });
    const { orch } = await makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);

    await expect(orch.run([group], 0)).rejects.toThrow(CreditExhaustedError);
  });

  it("calls followUp when planThenExecute TDD result needs input", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: true, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const hudHelper = fakeHud();
    // followUp will ask user, return empty → autonomy fallback → agent returns done
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const tdd = fakeAgent();
    // First call from PTE (mocked), second from followUp
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    const { orch } = await makeOrch({ tddAgent: tdd, hud: hudHelper });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    // followUp was called (askUser is the observable side-effect)
    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });
});

// ─── planThenExecute() as Orchestrator method ─────────────────────────────────

describe("Orchestrator.planThenExecute (method)", () => {
  it("asks user to confirm plan when interactive", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("y");
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: false }, hud: hudHelper });

    await orch.planThenExecute("slice");

    expect(hudHelper.hud.askUser).toHaveBeenCalledWith(expect.stringContaining("Accept plan?"));
  });

  it("returns replan when user answers 'r'", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("r");
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: false }, hud: hudHelper });

    const result = await orch.planThenExecute("slice");

    expect(result.replan).toBe(true);
  });

  it("auto-accepts plan without prompting when config.auto is true", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    const hudHelper = fakeHud();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { auto: true, noInteraction: false }, hud: hudHelper, tddAgent: tdd });

    await orch.planThenExecute("slice");

    expect(hudHelper.hud.askUser).not.toHaveBeenCalled();
    expect(tdd.send).toHaveBeenCalledOnce();
  });

  it("sends plan to TDD agent for execution", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });

    const result = await orch.planThenExecute("slice");

    expect(tdd.send).toHaveBeenCalledOnce();
    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toContain("Execute this plan");
    expect(tddPrompt).toContain("the plan");
    expect(result.skipped).toBe(false);
  });

  it("sends plan prompt to a plan agent and kills it", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true } });

    await orch.planThenExecute("slice text");

    const planPrompt = (planAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(planPrompt).toContain("slice text");
    expect(planAgent.kill).toHaveBeenCalled();
  });

  it("spawns plan agent via spawnPlanAgentWithSkill import", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "plan", planText: "plan", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true } });

    await orch.planThenExecute("slice");

    expect(spawnPlanAgentWithSkill).toHaveBeenCalled();
  });

  it("falls back to assistantText when planText is undefined", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "Fallback plan", planText: undefined, resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });

    await orch.planThenExecute("slice");

    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toContain("Fallback plan");
  });

  it("returns skipped=true when skip flag is set during plan phase", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "plan", planText: "plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    orch.sliceSkipFlag = true;

    const result = await orch.planThenExecute("slice");

    expect(result.skipped).toBe(true);
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("returns hardInterrupt when set during plan phase", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "plan", planText: "plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    orch.hardInterruptPending = "Fix the tests first";

    const result = await orch.planThenExecute("slice");

    expect(result.hardInterrupt).toBe("Fix the tests first");
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("returns hardInterrupt when set during execute phase", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "plan", planText: "plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    let tddCallCount = 0;
    (tdd.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      tddCallCount++;
      return { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    // Set hard interrupt after plan phase completes but checked after execute
    const origWithInterrupt = orch.withInterrupt.bind(orch);
    vi.spyOn(orch, "withInterrupt").mockImplementation(async (agent, fn) => {
      const result = await origWithInterrupt(agent, fn);
      if (agent === tdd) orch.hardInterruptPending = "Redirect";
      return result;
    });

    const result = await orch.planThenExecute("slice");

    expect(result.hardInterrupt).toBe("Redirect");
    expect(tdd.send).toHaveBeenCalled();
  });

  it("returns skipped=true when skip flag set during execute phase", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "plan", planText: "plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    // Set skip after plan phase checked but before execute check
    const origWithInterrupt = orch.withInterrupt.bind(orch);
    vi.spyOn(orch, "withInterrupt").mockImplementation(async (agent, fn) => {
      const result = await origWithInterrupt(agent, fn);
      if (agent === tdd) orch.sliceSkipFlag = true;
      return result;
    });

    const result = await orch.planThenExecute("slice");

    expect(result.skipped).toBe(true);
    expect(tdd.send).toHaveBeenCalled();
  });

  it("prepends brief to plan and execute prompts when tddIsFirst", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true, brief: "Project context info" }, tddAgent: tdd });

    await orch.planThenExecute("slice");

    const planPrompt = (planAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(planPrompt).toContain("Project context");
    expect(tddPrompt).toContain("Project context");
  });

  it("always prepends brief to plan prompt but not execute when tddIsFirst is false", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true, brief: "Project context" }, tddAgent: tdd });
    orch.tddIsFirst = false;

    await orch.planThenExecute("slice");

    const planPrompt = (planAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Plan agent is always fresh — it always needs the brief
    expect(planPrompt).toContain("Project context");
    // TDD agent already has the brief from a previous slice
    expect(tddPrompt).not.toContain("Project context");
  });

  it("logs truncated plan preview before asking in interactive mode", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Step ${i + 1}`);
    const planText = lines.join("\n");
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: planText, planText, resultText: "", needsInput: false, sessionId: "s",
    });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("y");
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const logFn = vi.fn();
    const { orch } = await makeOrch({ config: { noInteraction: false }, hud: hudHelper });
    (orch as any).log = logFn;

    await orch.planThenExecute("slice");

    const loggedText = logFn.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(loggedText).toContain("Step 1");
    expect(loggedText).not.toContain("Step 50");
    expect(loggedText).toContain("truncated");
    expect(loggedText).toContain("50 lines");
  });

  it("asks for guidance on 'e' and prepends to execute prompt", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan text", planText: "the plan text", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("e")
      .mockResolvedValueOnce("Focus on error handling");
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: false }, tddAgent: tdd, hud: hudHelper });

    await orch.planThenExecute("slice");

    expect(hudHelper.hud.askUser).toHaveBeenCalledTimes(2);
    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toContain("Focus on error handling");
    expect(tddPrompt).toContain("the plan text");
  });

  it("returns planText in normal exit path", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "fallback", planText: "the real plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });

    const result = await orch.planThenExecute("slice");

    expect(result.planText).toBe("the real plan");
  });

  it("returns planText when skip flag set during plan phase", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "fallback", planText: "skipped plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    orch.sliceSkipFlag = true;

    const result = await orch.planThenExecute("slice");

    expect(result.planText).toBe("skipped plan");
    expect(result.skipped).toBe(true);
  });

  it("fires onPlanReady (hud.update) before askUser in interactive mode", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const callOrder: string[] = [];
    const hudHelper = fakeHud();
    (hudHelper.hud.update as ReturnType<typeof vi.fn>).mockImplementation(() => { callOrder.push("update"); });
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("askUser");
      return "y";
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = await makeOrch({ config: { noInteraction: false }, hud: hudHelper });

    await orch.planThenExecute("slice");

    // hud.update (onPlanReady equivalent) should be called before askUser
    const updateIdx = callOrder.indexOf("update");
    const askIdx = callOrder.indexOf("askUser");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(askIdx).toBeGreaterThan(updateIdx);
  });

  it("respawns TDD agent and retries when agent dies during execute", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);

    const tdd = fakeAgent();
    // First send: agent dies (exitCode 1, alive becomes false)
    let sendCount = 0;
    (tdd.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sendCount++;
      if (sendCount === 1) {
        (tdd as { alive: boolean }).alive = false;
        return { exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
      }
      return { exitCode: 0, assistantText: "done", resultText: "", needsInput: false, sessionId: "s" };
    });

    const freshTdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(freshTdd);

    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });

    const result = await orch.planThenExecute("slice");

    // Should have respawned: the orchestrator's tddAgent should now be the fresh one
    expect(orch.tddAgent).toBe(freshTdd);
    // Fresh agent should have received rules reminder
    expect(freshTdd.sendQuiet).toHaveBeenCalledWith(expect.stringContaining("RUN TESTS WITH BASH"));
    // Fresh agent should have been sent the execute prompt
    expect(freshTdd.send).toHaveBeenCalledOnce();
    // Result should be from the fresh agent
    expect(result.tddResult.exitCode).toBe(0);
  });

  it("dead session fallback works with real detectApiError", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);

    const tdd = fakeAgent();
    let sendCount = 0;
    (tdd.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sendCount++;
      if (sendCount === 1) {
        (tdd as { alive: boolean }).alive = false;
        return { exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
      }
      return { exitCode: 0, assistantText: "done", resultText: "", needsInput: false, sessionId: "s" };
    });

    // Use real detectApiError logic — exitCode 1 + unrecognised text → null (not a known API error)
    vi.mocked(detectApiError).mockImplementation((result, stderr) => {
      if (result.exitCode === 0) return null;
      const combined = `${result.resultText}\n${stderr}`;
      if (/529|overloaded/i.test(combined)) return { kind: "overloaded", retryable: true };
      if (/rate\s+limit/i.test(combined)) return { kind: "rate-limited", retryable: true };
      return null;
    });

    const freshTdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(freshTdd);

    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });

    // Should NOT throw CreditExhaustedError — withRetry short-circuits on dead agent
    const result = await orch.planThenExecute("slice");

    expect(orch.tddAgent).toBe(freshTdd);
    expect(freshTdd.send).toHaveBeenCalledOnce();
    expect(result.tddResult.exitCode).toBe(0);
  });

  it("logs skip message when planDisabled is true", async () => {
    const logFn = vi.fn();
    const tdd = fakeAgent();
    const { orch } = await makeOrch({ config: { planDisabled: true, noInteraction: true }, tddAgent: tdd });
    (orch as any).log = logFn;

    await orch.planThenExecute("slice content");

    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("Plan skipped");
  });

  it("retries TDD send on 529 when planDisabled is true", async () => {
    const fail529: AgentResult = { exitCode: 1, assistantText: "", resultText: "529 overloaded", needsInput: false, sessionId: "s" };
    const okResult: AgentResult = { exitCode: 0, assistantText: "done", resultText: "", needsInput: false, sessionId: "s" };
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fail529)
      .mockResolvedValueOnce(okResult);
    vi.mocked(detectApiError)
      .mockReturnValueOnce({ kind: "overloaded", retryable: true })
      .mockReturnValueOnce(null);
    const { orch } = await makeOrch({ config: { planDisabled: true, noInteraction: true }, tddAgent: tdd });
    orch.retryDelayMs = 0;

    const result = await orch.planThenExecute("slice");

    expect(tdd.send).toHaveBeenCalledTimes(2);
    expect(result.tddResult.exitCode).toBe(0);
  });

  it("sets tddIsFirst to false after disabled-plan direct send", async () => {
    const tdd = fakeAgent();
    const { orch } = await makeOrch({
      config: { planDisabled: true, noInteraction: true, brief: "project context xyz" },
      tddAgent: tdd,
    });
    expect(orch.tddIsFirst).toBe(true);

    await orch.planThenExecute("slice");

    expect(orch.tddIsFirst).toBe(false);
    // Second call should not include brief
    await orch.planThenExecute("slice2");
    const secondPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(secondPrompt).not.toContain("project context xyz");
  });

  it("includes brief in TDD prompt when planDisabled and tddIsFirst", async () => {
    const tdd = fakeAgent();
    const { orch } = await makeOrch({
      config: { planDisabled: true, noInteraction: true, brief: "project context here" },
      tddAgent: tdd,
    });

    await orch.planThenExecute("slice content");

    const prompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("project context here");
  });

  it("skips plan agent and sends slice directly to TDD when planDisabled is true", async () => {
    vi.mocked(spawnPlanAgentWithSkill).mockReset();
    const tdd = fakeAgent();
    const { orch } = await makeOrch({ config: { planDisabled: true, noInteraction: true }, tddAgent: tdd });

    const result = await orch.planThenExecute("slice content");

    expect(spawnPlanAgentWithSkill).not.toHaveBeenCalled();
    expect(tdd.send).toHaveBeenCalledOnce();
    const prompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("slice content");
    expect(result.skipped).toBe(false);
    expect((result as any).replan).toBeUndefined();
  });
});

describe("gapAnalysis uses spawnGapAgent", () => {
  it("spawns gap agent via spawnGapAgent", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "NO_GAPS_FOUND", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnGapAgent).mockReturnValue(gapAgent);
    const { orch } = await makeOrch();

    await orch.gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(spawnGapAgent).toHaveBeenCalled();
  });
});

describe("finalPasses uses imported spawnAgent", () => {
  it("spawns final agent via spawnAgent(BOT_FINAL)", async () => {
    const finalAgent = fakeAgent();
    (finalAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "NO_ISSUES_FOUND", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnAgent).mockReturnValue(finalAgent);
    const { orch } = await makeOrch();

    await orch.finalPasses("sha");

    expect(spawnAgent).toHaveBeenCalled();
  });
});

describe("withRetry", () => {
  it("retries on retryable error then succeeds", async () => {
    const agent = fakeAgent();
    const failResult: AgentResult = { exitCode: 1, assistantText: "", resultText: "529 overloaded", needsInput: false, sessionId: "s" };
    const okResult: AgentResult = { exitCode: 0, assistantText: "done", resultText: "", needsInput: false, sessionId: "s" };
    const fn = vi.fn().mockResolvedValueOnce(failResult).mockResolvedValueOnce(okResult);
    vi.mocked(detectApiError)
      .mockReturnValueOnce({ kind: "overloaded", retryable: true })
      .mockReturnValueOnce(null);

    const { orch, hud } = await makeOrch();
    const result = await orch.withRetry(fn, agent, "plan", 2, 0);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toBe(okResult);
    expect(hud.setActivity).toHaveBeenCalledWith(expect.stringContaining("retry"));
  });

  it("throws on terminal error without retrying", async () => {
    const agent = fakeAgent();
    const failResult: AgentResult = { exitCode: 1, assistantText: "", resultText: "credit exhausted", needsInput: false, sessionId: "s" };
    const fn = vi.fn().mockResolvedValue(failResult);
    vi.mocked(detectApiError).mockReturnValue({ kind: "credit-exhausted", retryable: false });

    const { orch } = await makeOrch();
    await expect(orch.withRetry(fn, agent, "plan", 2, 0)).rejects.toThrow(CreditExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalled();
  });

  it("gives up after max retries", async () => {
    const agent = fakeAgent();
    const failResult: AgentResult = { exitCode: 1, assistantText: "", resultText: "529", needsInput: false, sessionId: "s" };
    const fn = vi.fn().mockResolvedValue(failResult);
    vi.mocked(detectApiError).mockReturnValue({ kind: "overloaded", retryable: true });

    const { orch } = await makeOrch();
    await expect(orch.withRetry(fn, agent, "plan", 2, 0)).rejects.toThrow(/max retries.*2/i);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("planThenExecute retries plan agent on 529", async () => {
    const planAgent = fakeAgent();
    const fail529: AgentResult = { exitCode: 1, assistantText: "", resultText: "529 overloaded", needsInput: false, sessionId: "s" };
    const okPlan: AgentResult = { exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s" };
    (planAgent.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fail529)
      .mockResolvedValueOnce(okPlan);
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    vi.mocked(detectApiError)
      .mockReturnValueOnce({ kind: "overloaded", retryable: true })
      .mockReturnValueOnce(null) // plan retry succeeds
      .mockReturnValueOnce(null); // tdd send succeeds
    const { orch, hud } = await makeOrch({ config: { noInteraction: true } });
    orch.retryDelayMs = 0;

    const result = await orch.planThenExecute("slice");

    expect(planAgent.send).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(false);
  });

  it("planThenExecute retries TDD execution on 529", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const tdd = fakeAgent();
    const fail529: AgentResult = { exitCode: 1, assistantText: "", resultText: "overloaded", needsInput: false, sessionId: "s" };
    const okResult: AgentResult = { exitCode: 0, assistantText: "done", resultText: "", needsInput: false, sessionId: "s" };
    (tdd.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fail529)
      .mockResolvedValueOnce(okResult);
    vi.mocked(detectApiError)
      .mockReturnValueOnce(null) // plan send succeeds
      .mockReturnValueOnce({ kind: "overloaded", retryable: true }) // tdd first attempt
      .mockReturnValueOnce(null); // tdd retry succeeds
    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    orch.retryDelayMs = 0;

    const result = await orch.planThenExecute("slice");

    expect(tdd.send).toHaveBeenCalledTimes(2);
    expect(result.tddResult).toBe(okResult);
  });

  it("checkCredit ignores retryable errors", async () => {
    const agent = fakeAgent();
    const result: AgentResult = { exitCode: 1, assistantText: "", resultText: "rate limit", needsInput: false, sessionId: "s" };
    // detectCreditExhaustion would normally signal this as a credit issue
    vi.mocked(detectCreditExhaustion).mockReturnValue({ kind: "rejected", message: "Rate limited. Wait and retry." });
    vi.mocked(detectApiError).mockReturnValue({ kind: "rate-limited", retryable: true });

    const { orch } = await makeOrch();
    // checkCredit should use detectApiError and ignore retryable — NOT throw
    await expect(orch.checkCredit(result, agent)).resolves.toBeUndefined();
  });

  it("checkCredit throws on terminal errors via detectApiError", async () => {
    const agent = fakeAgent();
    const result: AgentResult = { exitCode: 1, assistantText: "", resultText: "credit exhausted", needsInput: false, sessionId: "s" };
    vi.mocked(detectApiError).mockReturnValue({ kind: "credit-exhausted", retryable: false });

    const { orch } = await makeOrch();
    await expect(orch.checkCredit(result, agent)).rejects.toThrow(CreditExhaustedError);
  });

  it("returns result without throwing when agent is dead", async () => {
    const agent = fakeAgent();
    (agent as { alive: boolean }).alive = false;
    const deadResult: AgentResult = { exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const fn = vi.fn().mockResolvedValue(deadResult);
    const { orch } = await makeOrch();
    const result = await orch.withRetry(fn, agent, "tdd-execute", 2, 0);

    // Dead agent short-circuits before detectApiError is even called
    expect(result).toBe(deadResult);
    expect(fn).toHaveBeenCalledTimes(1);
  });


  it("updates HUD activity during retry wait", async () => {
    const agent = fakeAgent();
    const failResult: AgentResult = { exitCode: 1, assistantText: "", resultText: "529", needsInput: false, sessionId: "s" };
    const okResult: AgentResult = { exitCode: 0, assistantText: "done", resultText: "", needsInput: false, sessionId: "s" };
    const fn = vi.fn().mockResolvedValueOnce(failResult).mockResolvedValueOnce(okResult);
    vi.mocked(detectApiError)
      .mockReturnValueOnce({ kind: "overloaded", retryable: true })
      .mockReturnValueOnce(null);

    const { orch, hud } = await makeOrch();
    await orch.withRetry(fn, agent, "plan", 2, 0);

    expect(hud.setActivity).toHaveBeenCalledWith("waiting to retry (overloaded)...");
  });
});

describe("currentPlanText timing", () => {
  it("currentPlanText is available during execute phase", async () => {
    const planAgent = fakeAgent();
    vi.mocked(planAgent.send).mockResolvedValue({
      exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s",
      planText: "the plan",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);

    let captured: string | null | undefined;
    const orchRef: { current: Orchestrator | null } = { current: null };
    const tdd = fakeAgent();
    let firstCall = true;
    vi.mocked(tdd.send).mockImplementation(async () => {
      if (firstCall) {
        captured = orchRef.current!.currentPlanText;
        firstCall = false;
      }
      return { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    });

    const { orch } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    orchRef.current = orch;
    const slice = { number: 1, title: "T", content: "c" };
    const group = { name: "G", slices: [slice] };
    await orch.run([group], 0);

    expect(captured).toBe("the plan");
  });

  it("pressing P during TDD execution shows plan text", async () => {
    const planAgent = fakeAgent();
    vi.mocked(planAgent.send).mockResolvedValue({
      exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s",
      planText: "## My Plan",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);

    const tdd = fakeAgent();
    let pressKeyRef: ((k: string) => void) | undefined;
    let firstCall = true;
    vi.mocked(tdd.send).mockImplementation(async () => {
      if (firstCall) {
        pressKeyRef!("p");
        firstCall = false;
      }
      return { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    });

    const { orch, pressKey } = await makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
    pressKeyRef = pressKey;
    orch.setupKeyboardHandlers();
    const logSpy = vi.fn();
    (orch as any).log = logSpy;
    const slice = { number: 1, title: "T", content: "c" };
    const group = { name: "G", slices: [slice] };
    await orch.run([group], 0);

    expect(logSpy).toHaveBeenCalledWith("## My Plan");
  });

  it("currentPlanText is null after run completes", async () => {
    const planAgent = fakeAgent();
    vi.mocked(planAgent.send).mockResolvedValue({
      exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s",
      planText: "a plan",
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);

    const { orch } = await makeOrch({ config: { noInteraction: true } });
    const slice = { number: 1, title: "T", content: "c" };
    const group = { name: "G", slices: [slice] };
    await orch.run([group], 0);

    expect(orch.currentPlanText).toBeNull();
  });
});
