import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasDirtyTree, captureRef, hasChanges } from "../src/git/git.js";
import { spawnAgent, spawnPlanAgentWithSkill, spawnGapAgent } from "../src/agent/agent-factory.js";
import { detectCreditExhaustion } from "../src/agent/credit-detection.js";
import { detectApiError } from "../src/agent/api-errors.js";
import { saveState } from "../src/state/state.js";
import { isCleanReview } from "../src/cli/review-check.js";
import { measureDiff } from "../src/cli/review-threshold.js";
import { printSliceIntro, printSliceContent } from "../src/ui/display.js";
import { createTestOrch, fakeAgent, defaultResult } from "./orchestrator-harness.js";

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
  vi.mocked(printSliceIntro).mockReset();
  vi.mocked(printSliceContent).mockReset();
});

describe("orchestrator harness", () => {
  it("pressKey 's' outside skippable context does nothing", async () => {
    const { orch, pressKey } = await createTestOrch();
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(false);
  });

  it("pressKey 'c' with currentSlice set calls printSliceContent", async () => {
    const { orch, pressKey } = await createTestOrch();
    orch.currentSlice = {
      number: 1,
      title: "Test",
      content: "test content",
      why: "why",
      files: [],
      details: "details",
      tests: "tests",
    };
    pressKey("c");
    expect(printSliceContent).toHaveBeenCalledWith(expect.any(Function), orch.currentSlice);
  });
});

const testSlice = {
  number: 1,
  title: "Test",
  content: "test content",
  why: "why",
  files: [] as readonly { path: string; action: "new" | "edit" | "delete" }[],
  details: "details",
  tests: "tests",
};

describe("regression guards", () => {
  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("S key — sliceSkippable is true during slice execution", async () => {
    const { orch, pressKey, hud } = await createTestOrch();
    orch.sliceSkippable = true;
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(true);
    expect(hud.setSkipping).toHaveBeenCalledWith(true);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("S key — sliceSkipFlag toggles on repeated S presses", async () => {
    const { orch, pressKey, hud } = await createTestOrch();
    orch.sliceSkippable = true;
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(true);
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(false);
    expect(hud.setSkipping).toHaveBeenNthCalledWith(1, true);
    expect(hud.setSkipping).toHaveBeenNthCalledWith(2, false);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  // Exercises the real reset path: run() → planThenExecute checks sliceSkipFlag → returns skipped: true → run() resets flag
  it("S key — sliceSkipFlag resets after being consumed by run()", async () => {
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(fakeAgent());
    vi.mocked(spawnAgent).mockReturnValue(fakeAgent());
    vi.mocked(spawnGapAgent).mockReturnValue(fakeAgent());

    const { orch } = await createTestOrch({ noInteraction: true });
    // Set skip flag before run — planThenExecute will see it and return skipped: true
    orch.sliceSkipFlag = true;

    const groups = [{ name: "Test Group", slices: [testSlice] }];
    await orch.run(groups, 0);

    // The real reset at orchestrator.ts:839 should have cleared the flag
    expect(orch.sliceSkipFlag).toBe(false);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("C key — pressing C with currentSlice logs slice content", async () => {
    const { orch, pressKey } = await createTestOrch();
    orch.currentSlice = testSlice;
    pressKey("c");
    expect(printSliceContent).toHaveBeenCalledWith(expect.any(Function), testSlice);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("C key — pressing C without currentSlice does nothing", async () => {
    const { pressKey } = await createTestOrch();
    pressKey("c");
    expect(printSliceContent).not.toHaveBeenCalled();
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("P key — pressing P with currentPlanText logs plan", async () => {
    const { orch, pressKey, log } = await createTestOrch();
    orch.currentPlanText = "test plan";
    log.mockClear();
    pressKey("p");
    expect(log).toHaveBeenCalledWith("test plan");
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("P key — pressing P without currentPlanText does nothing", async () => {
    const { pressKey, log } = await createTestOrch();
    log.mockClear();
    pressKey("p");
    expect(log).not.toHaveBeenCalled();
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("sliceSkippable is true while planThenExecute runs", async () => {
    let captured: boolean | undefined;
    let orchRef: Awaited<ReturnType<typeof createTestOrch>>["orch"];
    const plan = fakeAgent();
    vi.mocked(plan.send).mockImplementation(() => {
      captured = orchRef.sliceSkippable;
      return Promise.resolve(defaultResult);
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(plan);

    const { orch } = await createTestOrch({ noInteraction: true });
    orchRef = orch;
    const groups = [{ name: "G", slices: [testSlice] }];
    await orch.run(groups, 0);

    expect(captured).toBe(true);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("sliceSkippable resets to false after a skipped slice", async () => {
    const { orch } = await createTestOrch({ noInteraction: true });
    orch.sliceSkipFlag = true;

    const groups = [{ name: "G", slices: [testSlice] }];
    await orch.run(groups, 0);

    expect(orch.sliceSkippable).toBe(false);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("sliceSkippable resets to false after normal slice completion", async () => {
    const { orch } = await createTestOrch({ noInteraction: true });

    const groups = [{ name: "G", slices: [testSlice] }];
    await orch.run(groups, 0);

    expect(orch.sliceSkippable).toBe(false);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("pressing S during slice execution toggles sliceSkipFlag via run()", async () => {
    let pressKeyRef: ((k: string) => void) | undefined;
    const plan = fakeAgent();
    vi.mocked(plan.send).mockImplementation(() => {
      pressKeyRef!("s");
      return Promise.resolve(defaultResult);
    });
    vi.mocked(spawnPlanAgentWithSkill).mockReturnValue(plan);

    const { orch, pressKey, hud } = await createTestOrch({ noInteraction: true });
    pressKeyRef = pressKey;
    const groups = [{ name: "G", slices: [testSlice] }];
    await orch.run(groups, 0);

    expect(hud.setSkipping).toHaveBeenCalledWith(true);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("HUD — update mock captures calls for state assertions", async () => {
    const { orch, hud } = await createTestOrch();
    orch.hud.update({ groupName: "Test Group" });
    expect(hud.update).toHaveBeenCalledWith(expect.objectContaining({ groupName: "Test Group" }));
  });
});
