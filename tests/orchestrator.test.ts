import { describe, it, expect, vi } from "vitest";
import { Orchestrator, CreditExhaustedError, type OrchestratorConfig, type GitPort } from "../src/orchestrator.js";
import type { AgentProcess, AgentResult, AgentStyle } from "../src/agent.js";
import type { Hud, KeyHandler, InterruptSubmitHandler } from "../src/hud.js";
import type { CreditSignal } from "../src/credit-detection.js";

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

const fakeGit = (overrides?: Partial<GitPort>): GitPort => ({
  hasDirtyTree: vi.fn().mockResolvedValue(false),
  captureRef: vi.fn().mockResolvedValue("abc123"),
  hasChanges: vi.fn().mockResolvedValue(true),
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
  git?: GitPort;
  detectCredit?: (result: AgentResult, stderr: string) => CreditSignal | null;
  persistState?: (path: string, state: unknown) => Promise<void>;
  isCleanReview?: (text: string) => boolean;
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
    overrides?.git ?? fakeGit(),
    overrides?.detectCredit ?? (() => null),
    overrides?.persistState ?? vi.fn().mockResolvedValue(undefined),
    overrides?.isCleanReview ?? (() => false),
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
    const { orch } = makeOrch({ tddAgent: tdd, git: fakeGit({ hasDirtyTree: vi.fn().mockResolvedValue(false) }) });
    await orch.commitSweep("Auth");
    expect(tdd.send).not.toHaveBeenCalled();
  });

  it("skips with warning when agent is not alive", async () => {
    const tdd = fakeAgent();
    Object.defineProperty(tdd, "alive", { value: false });
    const { orch } = makeOrch({ tddAgent: tdd, git: fakeGit({ hasDirtyTree: vi.fn().mockResolvedValue(true) }) });
    await orch.commitSweep("Auth");
    expect(tdd.send).not.toHaveBeenCalled();
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("not alive"));
  });

  it("sends commit sweep prompt when dirty", async () => {
    const tdd = fakeAgent();
    const { orch } = makeOrch({ tddAgent: tdd, git: fakeGit({ hasDirtyTree: vi.fn().mockResolvedValue(true) }) });
    await orch.commitSweep("Auth");
    expect(tdd.send).toHaveBeenCalledWith(expect.stringContaining("Auth"), expect.any(Function), expect.any(Function));
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes detected"));
  });

  it("logs success on exit 0", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    const { orch } = makeOrch({ tddAgent: tdd, git: fakeGit({ hasDirtyTree: vi.fn().mockResolvedValue(true) }) });
    await orch.commitSweep("Auth");
    expect(orch.log).toHaveBeenCalledWith(expect.stringContaining("commit sweep complete"));
  });

  it("logs failure on non-zero exit", async () => {
    const tdd = fakeAgent();
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId: "s" });
    const { orch } = makeOrch({ tddAgent: tdd, git: fakeGit({ hasDirtyTree: vi.fn().mockResolvedValue(true) }) });
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
    const { orch } = makeOrch({ tddAgent: tdd, hud: hudHelper, git: fakeGit({ hasDirtyTree: vi.fn().mockResolvedValue(true) }) });
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
    const git = fakeGit({ hasDirtyTree: vi.fn().mockResolvedValue(true) });
    const { orch } = makeOrch({ tddAgent: tdd, git });
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
    const git = fakeGit({ hasChanges: vi.fn().mockResolvedValue(false) });
    const { orch } = makeOrch({ reviewAgent: review, git });
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
    const git = fakeGit({ hasChanges: vi.fn().mockResolvedValue(true) });
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, git, config: { maxReviewCycles: 2 } });
    await orch.reviewFix("content", "sha1");
    expect(review.send).toHaveBeenCalledTimes(2);
  });

  it("forwards review findings to TDD agent", async () => {
    const review = fakeAgent();
    const tdd = fakeAgent();
    (review.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(reviewResult("off-by-one error"))
      .mockResolvedValue(reviewResult("REVIEW_CLEAN"));
    (tdd.send as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResult("fixed"));
    const git = fakeGit({ hasChanges: vi.fn().mockResolvedValue(true) });
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, git, isCleanReview: (t) => t.includes("REVIEW_CLEAN") });
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
    const git = fakeGit({ hasChanges: vi.fn().mockResolvedValue(true) });
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, git, config: { brief: "Project context", maxReviewCycles: 2 } });
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
    const git = fakeGit({
      hasChanges: vi.fn()
        .mockResolvedValueOnce(true)   // initial check — there are changes
        .mockResolvedValueOnce(false), // after fix — no changes
    });
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, git, config: { maxReviewCycles: 3 } });
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
    const git = fakeGit({ hasChanges: vi.fn().mockResolvedValue(true) });
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, hud: hudHelper, git, isCleanReview: (t) => t.includes("REVIEW_CLEAN") });
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
    const git = fakeGit({ hasChanges: vi.fn().mockResolvedValue(true) });
    const hudHelper = fakeHud();
    const { orch } = makeOrch({ reviewAgent: review, tddAgent: tdd, git, hud: hudHelper, isCleanReview: (t) => t.includes("REVIEW_CLEAN") });
    await orch.reviewFix("content", "sha1");
    expect(hudHelper.hud.update).toHaveBeenCalledWith(expect.objectContaining({ activeAgent: "REV" }));
    expect(hudHelper.hud.update).toHaveBeenCalledWith(expect.objectContaining({ activeAgent: "TDD" }));
  });
});
