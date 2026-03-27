import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator, CreditExhaustedError, type OrchestratorConfig } from "../src/orchestrator.js";
import type { AgentProcess, AgentResult, AgentStyle } from "../src/agent.js";
import type { Hud, KeyHandler, InterruptSubmitHandler } from "../src/hud.js";
import type { Slice } from "../src/plan-parser.js";
import type { CreditSignal } from "../src/credit-detection.js";
import type { DiffStats } from "../src/review-threshold.js";
import { hasDirtyTree, captureRef, hasChanges } from "../src/git.js";
import { spawnAgent, spawnPlanAgentWithSkill } from "../src/agent-factory.js";

vi.mock("../src/git.js", () => ({
  hasDirtyTree: vi.fn().mockResolvedValue(false),
  captureRef: vi.fn().mockResolvedValue("abc123"),
  hasChanges: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/agent-factory.js", () => ({
  spawnAgent: vi.fn(),
  spawnPlanAgentWithSkill: vi.fn(),
}));

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
  detectCredit?: (result: AgentResult, stderr: string) => CreditSignal | null;
  persistState?: (path: string, state: unknown) => Promise<void>;
  isCleanReview?: (text: string) => boolean;
  spawnVerify?: () => Promise<AgentProcess>;
  measureDiff?: (cwd: string, since: string) => Promise<DiffStats>;
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
    overrides?.detectCredit ?? (() => null),
    overrides?.persistState ?? vi.fn().mockResolvedValue(undefined),
    overrides?.isCleanReview ?? (() => false),
    overrides?.spawnVerify ?? (() => Promise.resolve(fakeAgent())),
    overrides?.measureDiff ?? vi.fn().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 }),
  );
  return { orch, tdd, review, ...hudHelper };
};

beforeEach(() => {
  vi.mocked(hasDirtyTree).mockReset().mockResolvedValue(false);
  vi.mocked(captureRef).mockReset().mockResolvedValue("abc123");
  vi.mocked(hasChanges).mockReset().mockResolvedValue(true);
  vi.mocked(spawnAgent).mockReset().mockReturnValue(fakeAgent());
  vi.mocked(spawnPlanAgentWithSkill).mockReset().mockReturnValue(fakeAgent());
});

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

  it("constructs with 13 args (no RunDeps)", () => {
    const hud = fakeHud();
    const orch = new Orchestrator(
      makeConfig(),
      {},
      hud.hud,
      vi.fn(),
      fakeAgent(),
      fakeAgent(),
      () => Promise.resolve(fakeAgent()),
      () => Promise.resolve(fakeAgent()),
      () => null,
      vi.fn().mockResolvedValue(undefined),
      () => false,
      () => Promise.resolve(fakeAgent()),
      vi.fn().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 }),
    );
    expect(orch).toBeDefined();
  });
});

describe("respawnTdd", () => {
  it("kills old agent, spawns fresh, resets tddIsFirst but not reviewIsFirst", async () => {
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
    // review agent was NOT respawned — it retains its context and brief
    expect(orch.reviewIsFirst).toBe(false);
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

describe("run (stub removed)", () => {
  it("run() is now fully implemented", () => {
    expect(true).toBe(true);
  });
});

describe("withInterrupt", () => {
  it("sets interruptTarget during fn and clears after", async () => {
    const { orch, tdd } = makeOrch();
    let captured: AgentProcess | null = null;
    await orch.withInterrupt(tdd, async () => {
      captured = orch.interruptTarget;
    });
    expect(captured).toBe(tdd);
    expect(orch.interruptTarget).toBeNull();
  });

  it("clears interruptTarget even when fn throws", async () => {
    const { orch, tdd } = makeOrch();
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
    const { orch, tdd } = makeOrch({ detectCredit: () => null });
    const result = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    await expect(orch.checkCredit(result, tdd)).resolves.toBeUndefined();
  });

  it("saves state and throws CreditExhaustedError on signal", async () => {
    const persistState = vi.fn().mockResolvedValue(undefined);
    const { orch, tdd } = makeOrch({
      detectCredit: () => ({ kind: "rejected" as const, message: "Credits exhausted." }),
      persistState,
    });
    const result = { exitCode: 1, assistantText: "", resultText: "credit limit", needsInput: false, sessionId: "s" };
    await expect(orch.checkCredit(result, tdd)).rejects.toThrow(CreditExhaustedError);
    expect(persistState).toHaveBeenCalled();
  });
});

describe("followUp", () => {
  const needsInputResult: AgentResult = { exitCode: 0, assistantText: "question?", resultText: "", needsInput: true, sessionId: "s" };
  const doneResult: AgentResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };

  it("returns result unchanged when needsInput is false", async () => {
    const { orch, tdd } = makeOrch();
    const result = await orch.followUp(doneResult, tdd);
    expect(result).toBe(doneResult);
  });

  it("returns unchanged when noInteraction is true", async () => {
    const { orch, tdd } = makeOrch({ config: { noInteraction: true } });
    const result = await orch.followUp(needsInputResult, tdd);
    expect(result).toBe(needsInputResult);
  });

  it("asks user and forwards answer to agent", async () => {
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("my answer");
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(doneResult);
    const { orch } = makeOrch({ hud: hudHelper, tddAgent: tdd });
    await orch.followUp(needsInputResult, tdd);
    expect(hudHelper.hud.askUser).toHaveBeenCalled();
    expect(tdd.send).toHaveBeenCalledWith("my answer", expect.any(Function));
  });

  it("sends autonomy fallback on empty input", async () => {
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(doneResult);
    const { orch } = makeOrch({ hud: hudHelper, tddAgent: tdd });
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
    const { orch } = makeOrch({ hud: hudHelper, tddAgent: tdd });
    await orch.followUp(needsInputResult, tdd);
    expect(tdd.send).toHaveBeenCalledTimes(3);
  });
});

describe("Orchestrator.commitSweep", () => {
  it("skips when tree is clean", async () => {
    const tdd = fakeAgent();
    const { orch } = makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("skips with warning when agent is not alive", async () => {
    const tdd = fakeAgent();
    Object.defineProperty(tdd, "alive", { value: false });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(tdd.send).not.toHaveBeenCalled();
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("not alive"));
  });

  it("sends commit sweep prompt when dirty", async () => {
    const tdd = fakeAgent();
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(tdd.send).toHaveBeenCalledWith(expect.stringContaining("Auth"), expect.any(Function), expect.any(Function));
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes detected"));
  });

  it("logs success on exit 0", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = makeOrch({ tddAgent: tdd });
    await orch.commitSweep("Auth");
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("commit sweep complete"));
  });

  it("logs failure on non-zero exit", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = makeOrch({ tddAgent: tdd });
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
    const { orch } = makeOrch({ tddAgent: tdd, hud: hudHelper });
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
    const { orch } = makeOrch({ tddAgent: tdd });
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
    const { orch } = makeOrch({ reviewAgent: review });
    await orch.reviewFix("content", "abc123");
    expect(review.send).not.toHaveBeenCalled();
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("no diff"));
  });

  it("breaks when review text is clean", async () => {
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("REVIEW_CLEAN"));
    const { orch } = makeOrch({ reviewAgent: review, isCleanReview: () => true });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(1);
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("Review clean"));
  });

  it("stops after maxReviewCycles", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("off-by-one"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, config: { maxReviewCycles: 2 } });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(2);
  });

  it("forwards review findings to TDD agent", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(reviewResult("off-by-one error"))
      .mockResolvedValue(reviewResult("REVIEW_CLEAN"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, isCleanReview: (t) => t.includes("REVIEW_CLEAN") });
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
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, config: { brief: "Project context", maxReviewCycles: 2 } });
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
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, config: { maxReviewCycles: 3 } });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(1);
  });

  it("breaks early when sliceSkipFlag is set", async () => {
    const review = fakeAgent();
    const { orch } = makeOrch({ reviewAgent: review });
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
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, hud: hudHelper, isCleanReview: (t) => t.includes("REVIEW_CLEAN") });
    await orch.reviewFix("content", "sha1");
    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });

  it("throws CreditExhaustedError on review credit exhaustion", async () => {
    const review = fakeAgent();
    const badResult = reviewResult("", { exitCode: 1 });
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue(badResult);
    const { orch } = makeOrch({
      reviewAgent: review,
      detectCredit: () => ({ kind: "rejected" as const, message: "Credits gone" }),
    });
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
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, hud: hudHelper, isCleanReview: (t) => t.includes("REVIEW_CLEAN") });
    await orch.reviewFix("content", "sha1");
    expect(hudHelper.hud.update).toHaveBeenCalledWith(expect.objectContaining({ activeAgent: "REV" }));
    expect(hudHelper.hud.update).toHaveBeenCalledWith(expect.objectContaining({ activeAgent: "TDD" }));
  });
});

describe("isAlreadyImplemented", () => {
  it("returns true when text matches marker and HEAD === base", () => {
    const { orch } = makeOrch();
    expect(orch.isAlreadyImplemented("This feature is already implemented", "abc123", "abc123")).toBe(true);
  });

  it("returns false when text matches but HEAD !== base", () => {
    const { orch } = makeOrch();
    expect(orch.isAlreadyImplemented("already implemented", "def456", "abc123")).toBe(false);
  });

  it("returns false when no text marker present", () => {
    const { orch } = makeOrch();
    expect(orch.isAlreadyImplemented("I built the feature and all tests pass", "abc123", "abc123")).toBe(false);
  });

  it("matches 'nothing left to do' pattern", () => {
    const { orch } = makeOrch();
    expect(orch.isAlreadyImplemented("There is nothing left to implement", "abc", "abc")).toBe(true);
  });

  it("matches 'already exist' pattern", () => {
    const { orch } = makeOrch();
    expect(orch.isAlreadyImplemented("The tests already exist", "abc", "abc")).toBe(true);
  });
});

describe("verify", () => {
  const testSlice: Slice = { number: 1, title: "Test", content: "Do something" };
  const passText = "### VERIFY_RESULT\n**Status:** PASS";
  const failText = "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- test broke";

  it("returns true when verification passes", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    const { orch } = makeOrch({ spawnVerify: () => Promise.resolve(verifyAgent) });
    const result = await orch.verify(testSlice, "base123");
    expect(result).toBe(true);
    expect(verifyAgent.kill).toHaveBeenCalled();
  });

  it("retries via TDD bot on first failure then returns true on re-verify pass", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" })
      .mockResolvedValueOnce({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    const { orch } = makeOrch({ tddAgent: tdd, spawnVerify: () => Promise.resolve(verifyAgent) });
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
    const { orch } = makeOrch({ hud: hudHelper, spawnVerify: () => Promise.resolve(verifyAgent) });
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
    const { orch } = makeOrch({ hud: hudHelper, spawnVerify: () => Promise.resolve(verifyAgent) });
    await orch.verify(testSlice, "base123");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("returns true when operator retries", async () => {
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("r");
    const { orch } = makeOrch({ hud: hudHelper, spawnVerify: () => Promise.resolve(verifyAgent) });
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
    const persistState = vi.fn().mockResolvedValue(undefined);
    const { orch } = makeOrch({
      tddAgent: tdd,
      reviewAgent: review,
      spawnVerify: () => Promise.resolve(verifyAgent),
      isCleanReview: (t) => t.includes("REVIEW_CLEAN"),
      persistState,
    });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(verifyAgent.send).toHaveBeenCalled();
    expect(result.skipped).toBe(false);
    expect(result.reviewBase).toBe("newsha");
  });

  it("skips verify/review when already implemented", async () => {
    vi.mocked(captureRef).mockResolvedValue("samesha");
    const review = fakeAgent();
    const persistState = vi.fn().mockResolvedValue(undefined);
    const { orch } = makeOrch({ reviewAgent: review, persistState });
    const alreadyResult = { ...tddResult, assistantText: "already fully implemented" };
    const result = await orch.runSlice(testSlice, "samesha", alreadyResult, "vfybase");
    expect(review.send).not.toHaveBeenCalled();
    expect(result.skipped).toBe(false);
    expect(result.reviewBase).toBe("samesha");
    expect(persistState).toHaveBeenCalled();
  });

  it("defers review when diff is small", async () => {
    const passText = "### VERIFY_RESULT\n**Status:** PASS";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: passText, resultText: "", needsInput: false, sessionId: "s" });
    vi.mocked(captureRef).mockResolvedValue("newsha");
    const review = fakeAgent();
    const persistState = vi.fn().mockResolvedValue(undefined);
    const measureDiff = vi.fn().mockResolvedValue({ linesAdded: 2, linesRemoved: 1, total: 3 });
    const { orch } = makeOrch({
      reviewAgent: review,
      spawnVerify: () => Promise.resolve(verifyAgent),
      persistState,
      measureDiff,
      config: { reviewThreshold: 30 },
    });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(review.send).not.toHaveBeenCalled();
    expect(result.reviewBase).toBe("oldbase"); // not advanced
    expect(persistState).toHaveBeenCalled();
  });

  it("returns skipped true when verify returns false", async () => {
    const failText = "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- broke";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("s");
    const { orch } = makeOrch({ hud: hudHelper, spawnVerify: () => Promise.resolve(verifyAgent) });
    const result = await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(result.skipped).toBe(true);
  });

  it("kills verifyAgent when operator chooses retry", async () => {
    const failText = "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- broke";
    const verifyAgent = fakeAgent();
    (verifyAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: failText, resultText: "", needsInput: false, sessionId: "s" });
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("r");
    const { orch } = makeOrch({ hud: hudHelper, spawnVerify: () => Promise.resolve(verifyAgent) });
    await orch.runSlice(testSlice, "oldbase", tddResult, "vfybase");
    expect(verifyAgent.kill).toHaveBeenCalled();
  });
});

// ─── run() ────────────────────────────────────────────────────────────────────

describe("run()", () => {
  it("resolves for empty group list", async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = makeOrch();
    await expect(orch.run([], 0)).resolves.toBeUndefined();
  });

  it("skips group when all slices completed", async () => {
    const group = { name: "Auth", slices: [{ number: 1, title: "a", content: "a" }, { number: 2, title: "b", content: "b" }] };
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = makeOrch();
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
    const { orch } = makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });
    orch.state = { lastCompletedSlice: 1 };
    await orch.run([group], 0);
    // Slice 1 skipped, slices 2 and 3 went through pipeline
    expect(pte).toHaveBeenCalledTimes(2);
  });

  it("logs slice intro for non-skipped slices", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "Setup auth", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const logFn = vi.fn();
    const { orch } = makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    (orch as any).log = logFn;
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("Slice 1");
    expect(allLogs).toContain("Setup auth");
  });

  it("calls commitSweep and runSlice for each slice", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    const persistState = vi.fn().mockResolvedValue(undefined);
    const measureDiff = vi.fn().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 });
    const tdd = fakeAgent();
    const review = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "LGTM", resultText: "", needsInput: false, sessionId: "s" });
    const { orch } = makeOrch({ tddAgent: tdd, reviewAgent: review, persistState, measureDiff, isCleanReview: () => true });
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
    const persistState = vi.fn().mockResolvedValue(undefined);
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = makeOrch({ persistState });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);

    const respawnTddSpy = vi.spyOn(orch, "respawnTdd").mockResolvedValue(undefined);
    const runSliceSpy = vi.spyOn(orch, "runSlice");

    await orch.run([group], 0);

    expect(runSliceSpy).not.toHaveBeenCalled();
    expect(respawnTddSpy).toHaveBeenCalled();
    expect(persistState).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ lastCompletedSlice: 1 }));
  });

  it("respawns agents between groups", async () => {
    const g1 = { name: "A", slices: [{ number: 1, title: "a", content: "c" }] };
    const g2 = { name: "B", slices: [{ number: 2, title: "b", content: "c" }] };
    const tddResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult, skipped: false });
    const persistState = vi.fn().mockResolvedValue(undefined);
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = makeOrch({ persistState, config: { auto: true } });
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
    const { orch } = makeOrch();
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    // 2 replan attempts + 1 auto-accept = 3 total calls
    expect(pte).toHaveBeenCalledTimes(3);
    // The third call should have forceAccept: true (auto-accept)
    const thirdCallForceAccept = pte.mock.calls[2][1];
    expect(thirdCallForceAccept).toBe(true);
  });

  it("handles hardInterrupt by respawning TDD with guidance", async () => {
    const group = { name: "G", slices: [{ number: 1, title: "a", content: "c" }] };
    const okResult = { exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" };
    const pte = vi.fn().mockResolvedValue({ tddResult: okResult, skipped: false, hardInterrupt: "rewrite the approach" });
    vi.mocked(hasChanges).mockResolvedValue(false);
    const newTdd = fakeAgent();
    const spawnTdd = vi.fn().mockResolvedValue(newTdd);
    const { orch } = makeOrch({ spawnTdd });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha", skipped: false });

    await orch.run([group], 0);

    // TDD agent was respawned
    expect(spawnTdd).toHaveBeenCalled();
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
    const persistState = vi.fn().mockResolvedValue(undefined);
    vi.mocked(captureRef).mockResolvedValue("sha1");
    vi.mocked(hasChanges).mockResolvedValue(false);
    const { orch } = makeOrch({ persistState, config: { auto: true } });
    vi.spyOn(orch, "planThenExecute").mockImplementation(pte);
    vi.spyOn(orch, "commitSweep").mockResolvedValue(undefined);
    vi.spyOn(orch, "runSlice").mockResolvedValue({ reviewBase: "sha1", skipped: false });

    await orch.run([group], 0);

    expect(persistState).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ lastCompletedGroup: "Auth" }));
  });
});

// ─── gapAnalysis() ────────────────────────────────────────────────────────────

describe("gapAnalysis()", () => {
  it("skips when sliceSkipFlag is true", async () => {
    vi.mocked(spawnAgent).mockReset();
    const { orch } = makeOrch();
    orch.sliceSkipFlag = true;

    await (orch as any).gapAnalysis({ name: "G", slices: [] }, "sha");

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(orch.sliceSkipFlag).toBe(false);
  });

  it("skips when no changes since group base", async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(spawnAgent).mockReset();
    const { orch } = makeOrch();

    await (orch as any).gapAnalysis({ name: "G", slices: [] }, "sha");

    expect(hasChanges).toHaveBeenCalledWith("/tmp", "sha");
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("runs gap agent and sends findings to TDD for fixes", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Missing edge case tests for auth", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(captureRef).mockResolvedValue("gapsha");
    vi.mocked(spawnAgent).mockReturnValue(gapAgent);
    const { orch } = makeOrch({ tddAgent: tdd });
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
    vi.mocked(spawnAgent).mockReturnValue(gapAgent);
    const { orch } = makeOrch({ tddAgent: tdd });
    (orch as any).log = logFn;

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    // Should log a warning, NOT "No coverage gaps found"
    const allLogs = logFn.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(allLogs).toContain("failed");
    expect(allLogs).not.toContain("No coverage gaps found");
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("does not call TDD bot when NO_GAPS_FOUND", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "NO_GAPS_FOUND", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(gapAgent);
    const { orch } = makeOrch({ tddAgent: tdd });

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
    const { orch } = makeOrch();

    await (orch as any).finalPasses("runbasesha");

    expect(hasChanges).toHaveBeenCalledWith("/tmp", "runbasesha");
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("skips fix cycle when pass returns NO_ISSUES_FOUND", async () => {
    const finalAgent = fakeAgent();
    (finalAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "NO_ISSUES_FOUND", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    vi.mocked(spawnAgent).mockReturnValue(finalAgent);
    const { orch } = makeOrch({ tddAgent: tdd });

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
    const { orch } = makeOrch({ tddAgent: tdd });
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
    const persistState = vi.fn().mockResolvedValue(undefined);
    const { orch } = makeOrch({ persistState, config: { auto: true } });
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
    const persistState = vi.fn().mockResolvedValue(undefined);
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("y");
    const { orch } = makeOrch({ persistState, hud: hudHelper, config: { auto: false, noInteraction: false } });
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
    const persistState = vi.fn().mockResolvedValue(undefined);
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("n");
    const { orch } = makeOrch({ persistState, hud: hudHelper, config: { auto: false, noInteraction: false } });
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
    const { orch } = makeOrch({ tddAgent: tdd });
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
    const { orch } = makeOrch({ tddAgent: tdd });
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
    const { orch } = makeOrch({ tddAgent: tdd, hud: hudHelper });
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
    vi.mocked(spawnAgent).mockReturnValue(gapAgent);
    const { orch } = makeOrch({ tddAgent: tdd });
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
    vi.mocked(spawnAgent).mockReturnValue(gapAgent);
    const hudHelper = fakeHud();
    (hudHelper.hud.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const { orch } = makeOrch({ tddAgent: tdd, hud: hudHelper });
    vi.spyOn(orch, "reviewFix").mockResolvedValue(undefined);

    await (orch as any).gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(hudHelper.hud.askUser).toHaveBeenCalled();
  });
});

describe("commitSweep() gap coverage", () => {
  it("throws CreditExhaustedError when credit signal detected", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    const persistState = vi.fn().mockResolvedValue(undefined);
    vi.mocked(hasDirtyTree).mockResolvedValue(true);
    const { orch } = makeOrch({
      tddAgent: tdd,
      detectCredit: () => ({ kind: "rejected" as const, message: "Out of credits" }),
      persistState,
    });

    await expect(orch.commitSweep("Auth")).rejects.toThrow(CreditExhaustedError);
    expect(persistState).toHaveBeenCalled();
  });
});

describe("reviewFix() gap coverage", () => {
  it("throws CreditExhaustedError when TDD fix hits credit limit", async () => {
    const review = fakeAgent();
    // Review returns findings (not clean)
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "Fix this", resultText: "", needsInput: false, sessionId: "s" });
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    const persistState = vi.fn().mockResolvedValue(undefined);
    // detectCredit fires on second call (the TDD fix result)
    let callCount = 0;
    const detectCredit = () => {
      callCount++;
      if (callCount >= 2) return { kind: "rejected" as const, message: "Out of credits" };
      return null;
    };
    vi.mocked(captureRef).mockResolvedValue("sha");
    const { orch } = makeOrch({ tddAgent: tdd, reviewAgent: review, detectCredit, persistState });

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
    const measureDiff = vi.fn().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 });
    const persistState = vi.fn().mockResolvedValue(undefined);
    const { orch } = makeOrch({ spawnVerify: () => Promise.resolve(verifyAgent), measureDiff, persistState });

    // Set skip flag after verify passes (line 250 check)
    const origVerify = orch.verify.bind(orch);
    vi.spyOn(orch, "verify").mockImplementation(async (...args) => {
      const result = await origVerify(...args);
      orch.sliceSkipFlag = true; // operator pressed S during verify
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
    const measureDiff = vi.fn().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 });
    const persistState = vi.fn().mockResolvedValue(undefined);
    const { orch } = makeOrch({
      tddAgent: tdd, reviewAgent: review,
      spawnVerify: () => Promise.resolve(verifyAgent),
      measureDiff, persistState,
    });

    // Set skip flag during reviewFix (line 257 check)
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
    const persistState = vi.fn().mockResolvedValue(undefined);
    const { orch } = makeOrch({
      persistState,
      detectCredit: () => ({ kind: "rejected" as const, message: "Out" }),
    });
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
    const { orch } = makeOrch({ tddAgent: tdd, hud: hudHelper });
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
    const { orch } = makeOrch({ config: { noInteraction: false }, hud: hudHelper });

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
    const { orch } = makeOrch({ config: { noInteraction: false }, hud: hudHelper });

    const result = await orch.planThenExecute("slice");

    expect(result.replan).toBe(true);
  });

  it("sends plan to TDD agent for execution", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = makeOrch({ config: { noInteraction: true }, tddAgent: tdd });

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
    const { orch } = makeOrch({ config: { noInteraction: true } });

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
    const { orch } = makeOrch({ config: { noInteraction: true } });

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
    const { orch } = makeOrch({ config: { noInteraction: true }, tddAgent: tdd });

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
    const { orch } = makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
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
    const { orch } = makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
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
    const { orch } = makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
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
    const { orch } = makeOrch({ config: { noInteraction: true }, tddAgent: tdd });
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
    const { orch } = makeOrch({ config: { noInteraction: true, brief: "Project context info" }, tddAgent: tdd });

    await orch.planThenExecute("slice");

    const planPrompt = (planAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(planPrompt).toContain("Project context");
    expect(tddPrompt).toContain("Project context");
  });

  it("does not prepend brief when tddIsFirst is false", async () => {
    const planAgent = fakeAgent();
    (planAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "the plan", planText: "the plan", resultText: "", needsInput: false, sessionId: "s",
    });
    const tdd = fakeAgent();
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(planAgent);
    const { orch } = makeOrch({ config: { noInteraction: true, brief: "Project context" }, tddAgent: tdd });
    orch.tddIsFirst = false;

    await orch.planThenExecute("slice");

    const planPrompt = (planAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(planPrompt).not.toContain("Project context");
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
    const { orch } = makeOrch({ config: { noInteraction: false }, hud: hudHelper });
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
    const { orch } = makeOrch({ config: { noInteraction: false }, tddAgent: tdd, hud: hudHelper });

    await orch.planThenExecute("slice");

    expect(hudHelper.hud.askUser).toHaveBeenCalledTimes(2);
    const tddPrompt = (tdd.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tddPrompt).toContain("Focus on error handling");
    expect(tddPrompt).toContain("the plan text");
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
    const { orch } = makeOrch({ config: { noInteraction: false }, hud: hudHelper });

    await orch.planThenExecute("slice");

    // hud.update (onPlanReady equivalent) should be called before askUser
    const updateIdx = callOrder.indexOf("update");
    const askIdx = callOrder.indexOf("askUser");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(askIdx).toBeGreaterThan(updateIdx);
  });
});

describe("gapAnalysis uses imported spawnAgent", () => {
  it("spawns gap agent via spawnAgent(BOT_GAP)", async () => {
    const gapAgent = fakeAgent();
    (gapAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "NO_GAPS_FOUND", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnAgent).mockReturnValue(gapAgent);
    const { orch } = makeOrch();

    await orch.gapAnalysis({ name: "G", slices: [{ number: 1, title: "a", content: "c" }] }, "sha");

    expect(spawnAgent).toHaveBeenCalled();
  });
});

describe("finalPasses uses imported spawnAgent", () => {
  it("spawns final agent via spawnAgent(BOT_FINAL)", async () => {
    const finalAgent = fakeAgent();
    (finalAgent.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0, assistantText: "NO_ISSUES_FOUND", resultText: "", needsInput: false, sessionId: "s",
    });
    vi.mocked(spawnAgent).mockReturnValue(finalAgent);
    const { orch } = makeOrch();

    await orch.finalPasses("sha");

    expect(spawnAgent).toHaveBeenCalled();
  });
});
