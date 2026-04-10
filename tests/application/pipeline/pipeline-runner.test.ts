import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPool } from "#application/agent-pool.js";
import { sliceUnit } from "#application/execution-unit.js";
import { createInterruptState } from "#application/interrupt-state.js";
import { createPipelineContext } from "#application/pipeline-context.js";
import { ExecutionUnitTierSelector } from "#application/ports/execution-unit-tier-selector.port.js";
import { ExecutionUnitTriager } from "#application/ports/execution-unit-triager.port.js";
import { RunOrchestration } from "#application/run-orchestration.js";
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
import type { PhaseHandler } from "#application/pipeline/phase-handler.js";
import { pipelineRunner } from "#application/pipeline/pipeline-runner.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import type { ExecutionMode, OrchestratorConfig, SkillSet } from "#domain/config.js";
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
  private guideCallback: ((guidance: string) => void) | null = null;
  private interruptCallback: ((guidance: string) => void) | null = null;
  private skipCallback: (() => boolean) | null = null;
  private quitCallback: (() => void) | null = null;

  registerInterrupts(): InterruptHandler {
    return {
      onGuide: (callback) => {
        this.guideCallback = callback;
      },
      onInterrupt: (callback) => {
        this.interruptCallback = callback;
      },
      onSkip: (callback) => {
        this.skipCallback = callback;
      },
      onQuit: (callback) => {
        this.quitCallback = callback;
      },
    };
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

  requestSkip(): boolean {
    return this.skipCallback?.() ?? false;
  }
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

  return { spawner, pool, interrupts, persistence, gate, progress, log, git, prompts, ctx };
};

const useSlowAgentClock = (calls = 60): void => {
  const spy = vi.spyOn(Date, "now");
  for (let index = 0; index < calls; index++) {
    spy.mockReturnValueOnce(index * 5_000);
  }
};

describe("pipelineRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs phases in order", async () => {
    useSlowAgentClock();
    const { spawner, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phases: readonly PhaseHandler[] = [
      {
        name: "review",
        persistedPhase: "review",
        agent: "review",
        prompt: () => "phase-1",
        isClean: () => true,
      },
      {
        name: "verify",
        persistedPhase: "verify",
        agent: "verify",
        prompt: () => "phase-2",
        isClean: () => true,
      },
      {
        name: "gap",
        persistedPhase: "gap",
        agent: "gap",
        prompt: () => "phase-3",
        isClean: () => true,
      },
    ];
    spawner.onNextSpawn("review", okResult({ assistantText: "clean 1" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: "clean 2" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "clean 3" }));

    await pipelineRunner(unit, phases, ctx);

    expect(spawner.spawned.map((spawn) => spawn.role)).toEqual(["review", "verify", "gap"]);
    expect(spawner.spawned.flatMap((spawn) => spawn.handle.sentPrompts)).toEqual([
      "phase-1",
      "phase-2",
      "phase-3",
    ]);
  });

  it("skips remaining phases on skip", async () => {
    useSlowAgentClock();
    const { spawner, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phases: readonly PhaseHandler[] = [
      {
        name: "review",
        persistedPhase: "review",
        agent: "review",
        prompt: (_unit, promptCtx) => {
          promptCtx.interrupts.toggleSkip();
          return "phase-1";
        },
        isClean: () => true,
      },
      {
        name: "verify",
        persistedPhase: "verify",
        agent: "verify",
        prompt: () => "phase-2",
        isClean: () => true,
      },
      {
        name: "gap",
        persistedPhase: "gap",
        agent: "gap",
        prompt: () => "phase-3",
        isClean: () => true,
      },
    ];
    spawner.onNextSpawn("review", okResult({ assistantText: "clean 1" }));

    await pipelineRunner(unit, phases, ctx);

    expect(spawner.spawned.flatMap((spawn) => spawn.handle.sentPrompts)).toEqual(["phase-1"]);
  });

  it("skips remaining phases on quit", async () => {
    const { spawner, interrupts, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phases: readonly PhaseHandler[] = [
      {
        name: "review",
        persistedPhase: "review",
        agent: "review",
        prompt: () => "phase-1",
        isClean: () => true,
      },
    ];
    interrupts.requestQuit();

    await pipelineRunner(unit, phases, ctx);

    expect(spawner.spawned).toHaveLength(0);
  });

  it("calls evaluateAndFix when not clean and fixPrompt exists", async () => {
    useSlowAgentClock();
    const { spawner, git, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase: PhaseHandler = {
      name: "review",
      persistedPhase: "review",
      agent: "review",
      prompt: () => "[REVIEW]",
      isClean: (result) => result.assistantText.includes("clean"),
      fixPrompt: (_unit, findings) => `[FIX] ${findings}`,
    };
    git.setHasChanges(true);
    spawner.onNextSpawn(
      "review",
      okResult({ assistantText: "dirty findings" }),
      okResult({ assistantText: "clean now" }),
    );
    spawner.onNextSpawn("tdd", okResult({ assistantText: "fixed" }));

    await pipelineRunner(unit, [phase], ctx);

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual(["[FIX] dirty findings"]);
  });

  it("does not enter evaluateAndFix when quit is requested during a dirty phase", async () => {
    useSlowAgentClock();
    const { spawner, git, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase: PhaseHandler = {
      name: "review",
      persistedPhase: "review",
      agent: "review",
      prompt: () => "[REVIEW]",
      isClean: (result) => result.assistantText.includes("clean"),
      fixPrompt: (_unit, findings) => `[FIX] ${findings}`,
    };
    git.setHasChanges(true);
    spawner.onNextSpawn(
      "review",
      () => {
        ctx.interrupts.requestQuit();
        return okResult({ assistantText: "dirty findings" });
      },
      okResult({ assistantText: "clean now" }),
    );
    spawner.onNextSpawn("tdd", okResult({ assistantText: "fixed" }));

    await pipelineRunner(unit, [phase], ctx);

    expect(spawner.agentsForRole("tdd")).toHaveLength(0);
    expect(spawner.lastAgent("review").sentPrompts).toEqual(["[REVIEW]"]);
  });

  it("skips evaluateAndFix when isClean returns true", async () => {
    useSlowAgentClock();
    const { spawner, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase: PhaseHandler = {
      name: "review",
      persistedPhase: "review",
      agent: "review",
      prompt: () => "[REVIEW]",
      isClean: () => true,
      fixPrompt: () => "[FIX]",
    };
    spawner.onNextSpawn("review", okResult({ assistantText: "already clean" }));

    await pipelineRunner(unit, [phase], ctx);

    expect(spawner.agentsForRole("tdd")).toHaveLength(0);
  });

  it("skips evaluateAndFix when no fixPrompt defined", async () => {
    useSlowAgentClock();
    const { spawner, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phase: PhaseHandler = {
      name: "review",
      persistedPhase: "review",
      agent: "review",
      prompt: () => "[REVIEW]",
      isClean: () => false,
    };
    spawner.onNextSpawn("review", okResult({ assistantText: "dirty findings" }));

    await pipelineRunner(unit, [phase], ctx);

    expect(spawner.agentsForRole("tdd")).toHaveLength(0);
  });

  it("persists phase state after each phase", async () => {
    useSlowAgentClock();
    const { spawner, persistence, ctx } = createHarness();
    const unit = sliceUnit(makeSlice(1), "Core");
    const phases: readonly PhaseHandler[] = [
      {
        name: "review pass",
        persistedPhase: "review",
        agent: "review",
        prompt: () => "phase-1",
        isClean: () => true,
      },
      {
        name: "verify pass",
        persistedPhase: "verify",
        agent: "verify",
        prompt: () => "phase-2",
        isClean: () => true,
      },
    ];
    spawner.onNextSpawn("review", okResult({ assistantText: "clean 1" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: "clean 2" }));

    await pipelineRunner(unit, phases, ctx);

    expect(persistence.saveHistory.map((state) => state.currentPhase)).toEqual(["review", "verify"]);
  });

  it("RunOrchestration routes completeness, verify, review, gap, and final through pipelineRunner", async () => {
    useSlowAgentClock();
    const { spawner, persistence, gate, git, prompts, progress, log } = createHarness();
    const uc = new RunOrchestration(
      spawner,
      persistence,
      gate,
      git,
      prompts,
      {
        ...DEFAULT_CONFIG,
        skills: { ...DEFAULT_SKILLS, gap: "test" },
      },
      progress,
      log,
      new FakeRolePromptResolver(),
      new TestExecutionUnitTierSelector(),
      new TestExecutionUnitTriager(),
    );
    prompts.finalPassesOverride = [{ name: "sanity", prompt: "final check" }];
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    spawner.onNextSpawn(
      "verify",
      okResult({
        assistantText:
          '### VERIFY_JSON\n```json\n{"status":"PASS","checks":[],"sliceLocalFailures":[],"outOfScopeFailures":[],"preExistingFailures":[],"runnerIssue":null,"retryable":false,"summary":"ok"}\n```',
      }),
    );
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    spawner.onNextSpawn("gap", okResult({ assistantText: "NO_GAPS_FOUND" }));
    spawner.onNextSpawn("final", okResult({ assistantText: "NO_ISSUES_FOUND" }));

    await uc.execute([
      {
        name: "Core",
        slices: [makeSlice(1)],
      },
    ]);

    expect(spawner.agentsForRole("tdd")).toHaveLength(1);
    expect(spawner.agentsForRole("completeness")).toHaveLength(1);
    expect(spawner.agentsForRole("verify")).toHaveLength(1);
    expect(spawner.agentsForRole("review")).toHaveLength(1);
    expect(spawner.agentsForRole("gap")).toHaveLength(1);
    expect(spawner.agentsForRole("final")).toHaveLength(1);
  });

  it("RunOrchestration treats non-zero gap exits as dirty and sends fixes back to TDD", async () => {
    useSlowAgentClock();
    const { spawner, persistence, gate, git, prompts, progress, log } = createHarness();
    const uc = new RunOrchestration(
      spawner,
      persistence,
      gate,
      git,
      prompts,
      {
        ...DEFAULT_CONFIG,
        skills: { ...DEFAULT_SKILLS, gap: "test", verify: null },
      },
      progress,
      log,
      new FakeRolePromptResolver(),
      new TestExecutionUnitTierSelector(),
      new TestExecutionUnitTriager(),
    );
    git.setHasChanges(true);
    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented" }),
      okResult({ assistantText: "fixed gap issue" }),
    );
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    spawner.onNextSpawn(
      "gap",
      okResult({ exitCode: 1, assistantText: "gap runner failed" }),
      okResult({ assistantText: "NO_GAPS_FOUND" }),
    );

    await uc.execute([
      {
        name: "Core",
        slices: [makeSlice(1)],
      },
    ]);

    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(2);
    expect(spawner.lastAgent("tdd").sentPrompts[0]).toContain("[TDD:1]");
    expect(spawner.lastAgent("tdd").sentPrompts[1]).toContain("[TDD:1]");
    expect(spawner.lastAgent("tdd").sentPrompts[1]).toContain("FIX: gap runner failed");
    expect(persistence.current.lastCompletedSlice).toBe(1);
  });

  it("RunOrchestration does not persist a skipped slice as completed", async () => {
    useSlowAgentClock();
    const { spawner, persistence, gate, git, prompts, progress, log } = createHarness();
    const uc = new RunOrchestration(
      spawner,
      persistence,
      gate,
      git,
      prompts,
      DEFAULT_CONFIG,
      progress,
      log,
      new FakeRolePromptResolver(),
      new TestExecutionUnitTierSelector(),
      new TestExecutionUnitTriager(),
    );
    spawner.onNextSpawn("tdd", () => {
      progress.requestSkip();
      return okResult({ assistantText: "implemented" });
    });

    await expect(
      uc.execute([
        {
          name: "Core",
          slices: [makeSlice(1)],
        },
      ]),
    ).rejects.toThrow("Skipped Core slice 1");

    expect(persistence.current.lastCompletedSlice).toBeUndefined();
  });

  it("RunOrchestration honors minAgentDurationMs and retryDelayMs overrides", async () => {
    const { spawner, persistence, gate, git, prompts, progress, log } = createHarness();
    const uc = new RunOrchestration(
      spawner,
      persistence,
      gate,
      git,
      prompts,
      {
        ...DEFAULT_CONFIG,
        skills: { ...DEFAULT_SKILLS, verify: null, gap: null },
      },
      progress,
      log,
      new FakeRolePromptResolver(),
      new TestExecutionUnitTierSelector(),
      new TestExecutionUnitTriager(),
    );
    uc.minAgentDurationMs = 0;
    uc.retryDelayMs = 0;
    const nowSpy = vi.spyOn(Date, "now");
    [0, 1, 10_000, 15_000, 20_000, 25_000].forEach((value) => {
      nowSpy.mockReturnValueOnce(value);
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));
    vi.useFakeTimers();

    let settled = false;
    const run = uc.execute([
      {
        name: "Core",
        slices: [makeSlice(1)],
      },
    ]);
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(1);
    const settledWithoutDefaultRetryDelay = settled;
    await vi.runAllTimersAsync();

    await expect(run).resolves.toBeUndefined();

    expect(settledWithoutDefaultRetryDelay).toBe(true);
    expect(spawner.agentsForRole("tdd")).toHaveLength(1);
  });

  it("RunOrchestration honors usage probe delay overrides", async () => {
    useSlowAgentClock();
    const { spawner, persistence, gate, git, prompts, progress, log } = createHarness();
    const uc = new RunOrchestration(
      spawner,
      persistence,
      gate,
      git,
      prompts,
      {
        ...DEFAULT_CONFIG,
        auto: true,
        skills: { ...DEFAULT_SKILLS, verify: null, gap: null },
      },
      progress,
      log,
      new FakeRolePromptResolver(),
      new TestExecutionUnitTierSelector(),
      new TestExecutionUnitTriager(),
    );
    uc.minAgentDurationMs = 0;
    uc.retryDelayMs = 0;
    uc.usageProbeDelayMs = 1;
    uc.usageProbeMaxDelayMs = 1;

    spawner.onNextSpawn(
      "tdd",
      okResult({ exitCode: 1, resultText: "usage limit exceeded" }),
      okResult({ assistantText: "implemented after probe" }),
    );
    spawner.onNextSpawn("tdd", okResult({ assistantText: "OK" }));
    spawner.onNextSpawn("completeness", okResult({ assistantText: "SLICE_COMPLETE" }));
    spawner.onNextSpawn("review", okResult({ assistantText: "REVIEW_CLEAN" }));

    vi.useFakeTimers();
    let settled = false;
    const run = uc.execute([
      {
        name: "Core",
        slices: [makeSlice(1)],
      },
    ]);
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(5);
    const settledWithinOverrideWindow = settled;
    await vi.runAllTimersAsync();
    await run;

    expect(settledWithinOverrideWindow).toBe(true);
  });
});
