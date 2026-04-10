import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPool } from "#application/agent-pool.js";
import { sliceUnit } from "#application/execution-unit.js";
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
import { evaluateAndFix } from "#application/pipeline/evaluate-and-fix.js";
import type { PhaseHandler } from "#application/pipeline/phase-handler.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import type { ExecutionMode, OrchestratorConfig, SkillSet } from "#domain/config.js";
import { IncompleteRunError } from "#domain/errors.js";
import type { Slice } from "#domain/plan.js";
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
  gap: null,
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
    return { kind: "stop" };
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

const createPoolStateAccessor = (initial: OrchestratorState = {}) => {
  let state = initial;

  return {
    get: () => state,
    update: (fn: (value: OrchestratorState) => OrchestratorState) => {
      state = fn(state);
    },
  };
};

const createHarness = () => {
  const config: OrchestratorConfig = DEFAULT_CONFIG;
  const spawner = new FakeAgentSpawner();
  const pool = new AgentPool(
    spawner,
    new FakeRolePromptResolver(),
    config,
    createPoolStateAccessor(),
    () => {},
    (role) => `[RULES:${role}]`,
  );
  const interrupts = createInterruptState();
  const persistence = new InMemoryStatePersistence();
  const gate = new TestOperatorGate();
  const progress = new TestProgressSink();
  const log = new FakeLogWriter();
  const git = new InMemoryGitOps();
  const prompts = new PassthroughPromptBuilder();
  const tierSelector = new TestExecutionUnitTierSelector();
  const triager = new TestExecutionUnitTriager();
  const ctx = createPipelineContext({
    config,
    git,
    persistence,
    progress,
    log,
    prompts,
    gate,
    pool,
    interrupts,
    triager,
    tierSelector,
  });

  return { config, spawner, pool, interrupts, persistence, gate, progress, log, git, prompts, ctx };
};

const useSlowAgentClock = (calls = 40): void => {
  const spy = vi.spyOn(Date, "now");
  for (let index = 0; index < calls; index++) {
    spy.mockReturnValueOnce(index * 5_000);
  }
};

const makePhase = (): PhaseHandler => ({
  name: "review",
  agent: "review",
  prompt: () => "[REVIEW]",
  isClean: (result) => result.assistantText.includes("clean"),
  fixPrompt: (_unit, findings) => `[FIX] ${findings}`,
});

describe("evaluateAndFix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("breaks immediately when TDD makes no changes", async () => {
    useSlowAgentClock();
    const { spawner, git, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase = makePhase();
    git.setHasChanges(false);
    spawner.onNextSpawn("tdd", okResult({ assistantText: "attempted fix" }));

    await expect(
      evaluateAndFix({
        evaluatorResult: okResult({ assistantText: "dirty findings" }),
        fixPromptBuilder: phase.fixPrompt!,
        isClean: phase.isClean,
        maxCycles: 3,
        unit,
        ctx,
        phase,
      }),
    ).rejects.toThrow(IncompleteRunError);

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual(["[FIX] dirty findings"]);
    expect(spawner.agentsForRole("review")).toHaveLength(0);
  });

  it("loops fix and re-evaluate until clean", async () => {
    useSlowAgentClock();
    const { spawner, git, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase = makePhase();
    git.queueHasChanges(true);
    spawner.onNextSpawn("tdd", okResult({ assistantText: "fixed" }));
    spawner.onNextSpawn("review", okResult({ assistantText: "clean now" }));

    await expect(
      evaluateAndFix({
        evaluatorResult: okResult({ assistantText: "dirty findings" }),
        fixPromptBuilder: phase.fixPrompt!,
        isClean: phase.isClean,
        maxCycles: 3,
        unit,
        ctx,
        phase,
      }),
    ).resolves.toBeUndefined();

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual(["[FIX] dirty findings"]);
    expect(spawner.lastAgent("review").sentPrompts).toEqual(["[REVIEW]"]);
  });

  it("stops after maxCycles", async () => {
    useSlowAgentClock();
    const { spawner, git, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase = makePhase();
    git.queueHasChanges(true, true);
    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "first fix" }),
      okResult({ assistantText: "second fix" }),
    );
    spawner.onNextSpawn(
      "review",
      okResult({ assistantText: "still dirty" }),
      okResult({ assistantText: "still dirty again" }),
    );

    await expect(
      evaluateAndFix({
        evaluatorResult: okResult({ assistantText: "dirty findings" }),
        fixPromptBuilder: phase.fixPrompt!,
        isClean: phase.isClean,
        maxCycles: 2,
        unit,
        ctx,
        phase,
      }),
    ).rejects.toThrow(IncompleteRunError);

    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(2);
  });

  it("stops on skip requested", async () => {
    useSlowAgentClock();
    const { spawner, git, interrupts, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase = makePhase();
    git.setHasChanges(true);
    git.onHasChanges = () => {
      interrupts.toggleSkip();
    };
    spawner.onNextSpawn("tdd", okResult({ assistantText: "attempted fix" }));

    await expect(
      evaluateAndFix({
        evaluatorResult: okResult({ assistantText: "dirty findings" }),
        fixPromptBuilder: phase.fixPrompt!,
        isClean: phase.isClean,
        maxCycles: 3,
        unit,
        ctx,
        phase,
      }),
    ).resolves.toBeUndefined();

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual(["[FIX] dirty findings"]);
    expect(spawner.agentsForRole("review")).toHaveLength(0);
  });

  it("calls commitSweep after fix with changes", async () => {
    useSlowAgentClock();
    const { spawner, git, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase = makePhase();
    git.setHasChanges(true);
    git.setDirty(true);
    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "fixed" }),
      okResult({ assistantText: "swept" }),
    );
    spawner.onNextSpawn("review", okResult({ assistantText: "clean now" }));

    await expect(
      evaluateAndFix({
        evaluatorResult: okResult({ assistantText: "dirty findings" }),
        fixPromptBuilder: phase.fixPrompt!,
        isClean: phase.isClean,
        maxCycles: 3,
        unit,
        ctx,
        phase,
      }),
    ).resolves.toBeUndefined();

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual(["[FIX] dirty findings", "[SWEEP] Slice 1"]);
  });
});
