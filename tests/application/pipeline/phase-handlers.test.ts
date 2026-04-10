import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPool } from "#application/agent-pool.js";
import { directUnit, groupedUnit, sliceUnit } from "#application/execution-unit.js";
import { createInterruptState } from "#application/interrupt-state.js";
import { createPipelineContext } from "#application/pipeline-context.js";
import { ExecutionUnitTierSelector } from "#application/ports/execution-unit-tier-selector.port.js";
import { ExecutionUnitTriager } from "#application/ports/execution-unit-triager.port.js";
import {
  OperatorGate,
  type CreditDecision,
  type GateDecision,
  type VerifyDecision,
} from "#application/ports/operator-gate.port.js";
import {
  ProgressSink,
  type InterruptHandler,
  type ProgressUpdate,
} from "#application/ports/progress-sink.port.js";
import {
  completenessPhase,
  executePhase,
  finalPhases,
  gapPhase,
  planPhase,
  reviewPhase,
  verifyPhase,
} from "#application/pipeline/phase-handlers.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import type { ExecutionMode, OrchestratorConfig, SkillSet } from "#domain/config.js";
import type { Group, Slice } from "#domain/plan.js";
import type { OrchestratorState } from "#domain/state.js";
import type { BoundaryTriageResult, ComplexityTriageResult } from "#domain/triage.js";
import { FakeAgentSpawner } from "../../fakes/fake-agent-spawner.js";
import { InMemoryGitOps } from "../../fakes/fake-git-ops.js";
import { FakeLogWriter } from "../../fakes/fake-log-writer.js";
import { PassthroughPromptBuilder } from "../../fakes/fake-prompt-builder.js";
import { FakeRolePromptResolver } from "../../fakes/fake-role-prompt-resolver.js";
import { InMemoryStatePersistence } from "../../fakes/fake-state-persistence.js";

const DEFAULT_SKILLS: SkillSet = {
  tdd: "test",
  review: "test",
  verify: "test",
  plan: "test",
  gap: "test",
  completeness: "test",
};

const DEFAULT_CONFIG: OrchestratorConfig = {
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief",
  executionMode: "sliced",
  executionPreference: "auto",
  auto: false,
  reviewThreshold: 30,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  logPath: null,
  tier: "medium",
  skills: DEFAULT_SKILLS,
  maxReplans: 3,
  defaultProvider: "claude",
  agentConfig: AGENT_DEFAULTS,
};

const okResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "session-ok",
  ...overrides,
});

class TestOperatorGate extends OperatorGate {
  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    return { kind: "accept" };
  }

  async verifyFailed(
    _executionUnitLabel: string,
    _summary: string,
    _retryable: boolean,
  ): Promise<VerifyDecision> {
    return { kind: "skip" };
  }

  async creditExhausted(_label: string, _message: string): Promise<CreditDecision> {
    return { kind: "retry" };
  }

  async askUser(_prompt: string): Promise<string> {
    return "";
  }

  async confirmNextGroup(_groupLabel: string): Promise<boolean> {
    return true;
  }
}

class TestProgressSink extends ProgressSink {
  registerInterrupts(): InterruptHandler {
    return { onGuide: () => {}, onInterrupt: () => {}, onSkip: () => {}, onQuit: () => {} };
  }

  updateProgress(_update: ProgressUpdate): void {}

  setActivity(_summary: string): void {}

  log(_text: string): void {}

  logExecutionMode(_executionMode: ExecutionMode): void {}

  createStreamer(_role: AgentRole): (text: string) => void {
    return () => {};
  }

  logSliceIntro(_slice: Slice): void {}

  logBadge(_role: AgentRole, _phase: string): void {}

  clearSkipping(): void {}

  teardown(): void {}
}

class TestExecutionUnitTierSelector extends ExecutionUnitTierSelector {
  async select(): Promise<ComplexityTriageResult> {
    return { tier: "medium", reason: "test" };
  }
}

class TestExecutionUnitTriager extends ExecutionUnitTriager {
  async decide(): Promise<BoundaryTriageResult> {
    return {
      verify: "run_now",
      completeness: "run_now",
      review: "run_now",
      gap: "run_now",
      reason: "test",
    };
  }
}

const makeSlice = (number: number): Slice => ({
  number,
  title: `Slice ${number}`,
  content: `Content ${number}`,
  why: "why",
  files: [],
  details: "details",
  tests: "tests",
});

const makeGroup = (): Group => ({
  name: "Core",
  slices: [makeSlice(1), makeSlice(2)],
});

const createPoolStateAccessor = (initial: OrchestratorState = {}) => {
  let state = initial;

  return {
    get: () => state,
    update: (fn: (value: OrchestratorState) => OrchestratorState) => {
      state = fn(state);
    },
  };
};

const createContext = (initialState: OrchestratorState = {}) => {
  const config: OrchestratorConfig = DEFAULT_CONFIG;
  const prompts = new PassthroughPromptBuilder();
  const spawner = new FakeAgentSpawner();
  const pool = new AgentPool(
    spawner,
    new FakeRolePromptResolver(),
    config,
    createPoolStateAccessor(initialState),
    () => {},
    (role) => `[RULES:${role}]`,
  );
  const ctx = createPipelineContext({
    config,
    initialState,
    git: new InMemoryGitOps(),
    persistence: new InMemoryStatePersistence(),
    progress: new TestProgressSink(),
    log: new FakeLogWriter(),
    prompts,
    gate: new TestOperatorGate(),
    pool,
    interrupts: createInterruptState(),
    triager: new TestExecutionUnitTriager(),
    tierSelector: new TestExecutionUnitTierSelector(),
  });

  return { ctx, prompts, spawner };
};

const verifyJson = (status: "PASS" | "FAIL"): string =>
  `### VERIFY_JSON
\`\`\`json
{"status":"${status}","checks":[],"sliceLocalFailures":[],"outOfScopeFailures":[],"preExistingFailures":[],"runnerIssue":null,"retryable":false,"summary":"${status}"}
\`\`\``;

describe("phase handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("planPhase dispatches to plan for slice units", () => {
    const { ctx, prompts } = createContext();
    const promptSpy = vi.spyOn(prompts, "plan");

    const prompt = planPhase.prompt(sliceUnit(makeSlice(3), "Core"), ctx);

    expect(prompt).toContain("[PLAN:3]");
    expect(promptSpy).toHaveBeenCalledWith(expect.any(String), 3);
  });

  it("executePhase dispatches to directExecute for direct units", () => {
    const { ctx, prompts } = createContext();
    const promptSpy = vi.spyOn(prompts, "directExecute");

    const prompt = executePhase.prompt(directUnit("ship it", 1), ctx);

    expect(prompt).toContain("[DIRECT]");
    expect(promptSpy).toHaveBeenCalledWith("ship it");
  });

  it("executePhase dispatches to groupedExecute for group units", () => {
    const { ctx, prompts } = createContext();
    const promptSpy = vi.spyOn(prompts, "groupedExecute");

    executePhase.prompt(groupedUnit(makeGroup()), ctx);

    expect(promptSpy).toHaveBeenCalledWith("Core", expect.any(String), false);
  });

  it("completeness isClean: true when SLICE_COMPLETE present without MISSING", () => {
    expect(
      completenessPhase.isClean(
        okResult({ assistantText: "SLICE_COMPLETE" }),
        sliceUnit(makeSlice(1), "Core"),
      ),
    ).toBe(true);
  });

  it("completeness isClean: false when ❌ present", () => {
    expect(
      completenessPhase.isClean(
        okResult({ assistantText: "SLICE_COMPLETE\n❌ MISSING" }),
        sliceUnit(makeSlice(1), "Core"),
      ),
    ).toBe(false);
  });

  it("completeness isClean: false when MISSING present without sentinel", () => {
    expect(
      completenessPhase.isClean(
        okResult({ assistantText: "MISSING tests" }),
        sliceUnit(makeSlice(1), "Core"),
      ),
    ).toBe(false);
  });

  it("completeness isClean: uses GROUP_COMPLETE for group units", () => {
    expect(
      completenessPhase.isClean(okResult({ assistantText: "GROUP_COMPLETE" }), groupedUnit(makeGroup())),
    ).toBe(true);
  });

  it("completeness isClean: uses DIRECT_COMPLETE for direct units", () => {
    expect(
      completenessPhase.isClean(okResult({ assistantText: "DIRECT_COMPLETE" }), directUnit("request", 1)),
    ).toBe(true);
  });

  it("completeness isClean: only accepts the unit-specific completion sentinel", () => {
    const direct = directUnit("request content", 4);
    const group = groupedUnit(makeGroup());
    const slice = sliceUnit(makeSlice(4), "Core");
    const isCleanFor = (unit: typeof direct | typeof group | typeof slice, assistantText: string) =>
      completenessPhase.isClean(okResult({ assistantText }), unit);

    expect(isCleanFor(direct, "DIRECT_COMPLETE")).toBe(true);
    expect(isCleanFor(direct, "GROUP_COMPLETE")).toBe(false);
    expect(isCleanFor(direct, "SLICE_COMPLETE")).toBe(false);

    expect(isCleanFor(group, "GROUP_COMPLETE")).toBe(true);
    expect(isCleanFor(group, "DIRECT_COMPLETE")).toBe(false);
    expect(isCleanFor(group, "SLICE_COMPLETE")).toBe(false);

    expect(isCleanFor(slice, "SLICE_COMPLETE")).toBe(true);
    expect(isCleanFor(slice, "DIRECT_COMPLETE")).toBe(false);
    expect(isCleanFor(slice, "GROUP_COMPLETE")).toBe(false);
  });

  it("verify isClean: true when PASS status", () => {
    expect(verifyPhase.isClean(okResult({ assistantText: verifyJson("PASS") }))).toBe(true);
  });

  it("verify isClean: false when FAIL status", () => {
    expect(verifyPhase.isClean(okResult({ assistantText: verifyJson("FAIL") }))).toBe(false);
  });

  it("verify isClean: false on unparseable result", () => {
    expect(verifyPhase.isClean(okResult({ assistantText: "garbage" }))).toBe(false);
  });

  it("review isClean: true on REVIEW_CLEAN text", () => {
    expect(reviewPhase.isClean(okResult({ assistantText: "REVIEW_CLEAN" }))).toBe(true);
  });

  it("review isClean: true on empty text", () => {
    expect(reviewPhase.isClean(okResult({ assistantText: "" }))).toBe(true);
  });

  it("review isClean: false on findings text", () => {
    expect(reviewPhase.isClean(okResult({ assistantText: "Fix the null handling" }))).toBe(false);
  });

  it("gap isClean: true on NO_GAPS_FOUND", () => {
    expect(gapPhase.isClean(okResult({ assistantText: "NO_GAPS_FOUND" }))).toBe(true);
  });

  it("gap isClean: false on non-zero exit code", () => {
    expect(gapPhase.isClean(okResult({ exitCode: 1, assistantText: "tool failed" }))).toBe(false);
  });

  it("gap isClean: false on gap findings text", () => {
    expect(gapPhase.isClean(okResult({ assistantText: "Found uncovered path" }))).toBe(false);
  });

  it("final isClean: true on NO_ISSUES_FOUND", () => {
    const { ctx, prompts } = createContext();
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "final prompt" }];
    const [phase] = finalPhases("base-sha", ctx);

    expect(phase.isClean(okResult({ assistantText: "NO_ISSUES_FOUND" }))).toBe(true);
  });

  it("final isClean: false on findings text", () => {
    const { ctx, prompts } = createContext();
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "final prompt" }];
    const [phase] = finalPhases("base-sha", ctx);

    expect(phase.isClean(okResult({ assistantText: "Missing type guard" }))).toBe(false);
  });

  it("completeness prompt dispatches to directCompleteness for direct unit", () => {
    const { ctx, prompts } = createContext({ reviewBaseSha: "review-sha" });
    const promptSpy = vi.spyOn(prompts, "directCompleteness");

    completenessPhase.prompt(directUnit("request content", 4), ctx);

    expect(promptSpy).toHaveBeenCalledWith("request content", "review-sha");
  });

  it("completeness prompt dispatches to completeness for slice unit", () => {
    const { ctx, prompts } = createContext({ reviewBaseSha: "review-sha" });
    const promptSpy = vi.spyOn(prompts, "completeness");

    completenessPhase.prompt(sliceUnit(makeSlice(4), "Core"), ctx);

    expect(promptSpy).toHaveBeenCalledWith(expect.any(String), "review-sha", 4);
  });

  it("verify prompt dispatches to groupedVerify for group unit", () => {
    const { ctx, prompts } = createContext({ currentGroupBaseSha: "group-sha" });
    const promptSpy = vi.spyOn(prompts, "groupedVerify");

    verifyPhase.prompt(groupedUnit(makeGroup()), ctx);

    expect(promptSpy).toHaveBeenCalledWith("group-sha", "Core", undefined);
  });

  it("verify prompt prefers the deferred verify base over the ambient group base", () => {
    const { ctx, prompts } = createContext({
      currentGroupBaseSha: "group-sha",
      pendingVerifyBaseSha: "deferred-verify-sha",
    });
    const promptSpy = vi.spyOn(prompts, "groupedVerify");

    verifyPhase.prompt(groupedUnit(makeGroup()), ctx);

    expect(promptSpy).toHaveBeenCalledWith("deferred-verify-sha", "Core", undefined);
  });

  it("completeness fixPrompt delegates to prompts.tdd with findings", () => {
    const { ctx, prompts } = createContext();
    const tddSpy = vi.spyOn(prompts, "tdd");

    completenessPhase.fixPrompt?.(sliceUnit(makeSlice(2), "Core"), "missing tests", ctx);

    expect(tddSpy).toHaveBeenCalledWith(expect.any(String), "missing tests", 2);
  });

  it("verify fixPrompt delegates slice-local failures to prompts.tdd", () => {
    const { ctx, prompts } = createContext();
    const tddSpy = vi.spyOn(prompts, "tdd");
    const findings = `### VERIFY_JSON
\`\`\`json
{"status":"FAIL","checks":[],"sliceLocalFailures":["fix a","fix b"],"outOfScopeFailures":[],"preExistingFailures":[],"runnerIssue":null,"retryable":true,"summary":"failed"}
\`\`\``;

    verifyPhase.fixPrompt?.(sliceUnit(makeSlice(2), "Core"), findings, ctx);

    expect(tddSpy).toHaveBeenCalledWith(expect.any(String), "fix a\nfix b", 2);
  });

  it("review fixPrompt delegates to prompts.tdd with findings", () => {
    const { ctx, prompts } = createContext();
    const tddSpy = vi.spyOn(prompts, "tdd");

    reviewPhase.fixPrompt?.(sliceUnit(makeSlice(2), "Core"), "fix the review items", ctx);

    expect(tddSpy).toHaveBeenCalledWith(expect.any(String), "fix the review items", 2);
  });

  it("gap fixPrompt delegates to prompts.tdd with findings", () => {
    const { ctx, prompts } = createContext();
    const tddSpy = vi.spyOn(prompts, "tdd");

    gapPhase.fixPrompt?.(sliceUnit(makeSlice(2), "Core"), "close the gap", ctx);

    expect(tddSpy).toHaveBeenCalledWith(expect.any(String), "close the gap", 2);
  });

  it("finalPhases maps prompt builder passes and wraps prompts with brief", () => {
    const { ctx, prompts } = createContext();
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "final prompt" }];

    const [phase] = finalPhases("base-sha", ctx);

    expect(phase.name).toBe("sanity");
    expect(phase.prompt(sliceUnit(makeSlice(1), "Core"), ctx)).toBe("[BRIEF] final prompt");
  });

  it("finalPhases fixPrompt delegates to prompts.tdd with findings", () => {
    const { ctx, prompts } = createContext();
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "final prompt" }];
    const tddSpy = vi.spyOn(prompts, "tdd");
    const [phase] = finalPhases("base-sha", ctx);

    phase.fixPrompt?.(sliceUnit(makeSlice(5), "Core"), "final findings", ctx);

    expect(tddSpy).toHaveBeenCalledWith(expect.any(String), "final findings", 5);
  });
});
