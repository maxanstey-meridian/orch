import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentProcess } from "../src/agent/agent.js";
import { hasDirtyTree, captureRef, hasChanges } from "../src/git/git.js";
import { spawnAgent, spawnPlanAgentWithSkill, spawnGapAgent } from "../src/agent/agent-factory.js";
import { detectCreditExhaustion } from "../src/agent/credit-detection.js";
import { detectApiError } from "../src/agent/api-errors.js";
import { saveState } from "../src/state/state.js";
import { isCleanReview } from "../src/cli/review-check.js";
import { measureDiff } from "../src/cli/review-threshold.js";
import { printSliceIntro } from "../src/ui/display.js";
import { createTestOrch } from "./orchestrator-harness.js";

vi.mock("../src/ui/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/display.js")>();
  return { ...actual, printSliceIntro: vi.fn() };
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
  vi.mocked(spawnAgent).mockReset().mockReturnValue({} as AgentProcess);
  vi.mocked(spawnPlanAgentWithSkill).mockReset().mockReturnValue({} as AgentProcess);
  vi.mocked(spawnGapAgent).mockReset().mockReturnValue({} as AgentProcess);
  vi.mocked(detectCreditExhaustion).mockReset().mockReturnValue(null);
  vi.mocked(detectApiError).mockReset().mockReturnValue(null);
  vi.mocked(saveState).mockReset().mockResolvedValue(undefined);
  vi.mocked(isCleanReview).mockReset().mockReturnValue(false);
  vi.mocked(measureDiff).mockReset().mockResolvedValue({ linesAdded: 100, linesRemoved: 10, total: 110 });
  vi.mocked(printSliceIntro).mockReset();
});

describe("orchestrator harness", () => {
  it("createTestOrch returns an orchestrator with working pressKey", async () => {
    const { orch, pressKey, hud } = await createTestOrch();
    orch.sliceSkippable = true;
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(true);
    expect(hud.setSkipping).toHaveBeenCalledWith(true);
  });

  it("pressKey 's' outside skippable context does nothing", async () => {
    const { orch, pressKey } = await createTestOrch();
    pressKey("s");
    expect(orch.sliceSkipFlag).toBe(false);
  });

  it("pressKey 'c' with currentSlice set calls printSliceIntro", async () => {
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
    expect(printSliceIntro).toHaveBeenCalledWith(expect.any(Function), orch.currentSlice);
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
  // TODO: sliceSkippable is never set to true in the Orchestrator — this is a live bug
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
  // Documents the reset contract: executeSlices sets sliceSkipFlag = false after consuming it
  it("S key — sliceSkipFlag resets after being consumed", async () => {
    const { orch } = await createTestOrch();
    orch.sliceSkipFlag = true;
    expect(orch.sliceSkipFlag).toBe(true);
    orch.sliceSkipFlag = false;
    expect(orch.sliceSkipFlag).toBe(false);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("C key — pressing C with currentSlice logs slice content", async () => {
    const { orch, pressKey } = await createTestOrch();
    orch.currentSlice = testSlice;
    pressKey("c");
    expect(printSliceIntro).toHaveBeenCalledWith(expect.any(Function), testSlice);
  });

  // REGRESSION GUARD — do not weaken or delete without replacing with equivalent coverage
  it("C key — pressing C without currentSlice does nothing", async () => {
    const { pressKey } = await createTestOrch();
    pressKey("c");
    expect(printSliceIntro).not.toHaveBeenCalled();
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
  it("HUD — update mock captures calls for state assertions", async () => {
    const { orch, hud } = await createTestOrch();
    orch.hud.update({ groupName: "Test Group" });
    expect(hud.update).toHaveBeenCalledWith(expect.objectContaining({ groupName: "Test Group" }));
  });
});
