import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPool } from "#application/agent-pool.js";
import { createInterruptState } from "#application/interrupt-state.js";
import { createPipelineContext } from "#application/pipeline-context.js";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
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
import { withRetry } from "#application/with-retry.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import type { OrchestratorConfig, SkillSet } from "#domain/config.js";
import type { ExecutionMode } from "#domain/config.js";
import { CreditExhaustedError, IncompleteRunError } from "#domain/errors.js";
import type { Slice } from "#domain/plan.js";
import type { OrchestratorState } from "#domain/state.js";
import type { ComplexityTriageResult } from "#domain/triage.js";
import type { BoundaryTriageResult } from "#domain/triage.js";
import { FakeAgentSpawner } from "../fakes/fake-agent-spawner.js";
import { InMemoryGitOps } from "../fakes/fake-git-ops.js";
import { FakeLogWriter } from "../fakes/fake-log-writer.js";
import { PassthroughPromptBuilder } from "../fakes/fake-prompt-builder.js";
import { FakeRolePromptResolver } from "../fakes/fake-role-prompt-resolver.js";
import { InMemoryStatePersistence } from "../fakes/fake-state-persistence.js";

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
  readonly creditCalls: Array<{ label: string; message: string }> = [];
  creditDecision: CreditDecision = { kind: "retry" };

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

  async creditExhausted(label: string, message: string): Promise<CreditDecision> {
    this.creditCalls.push({ label, message });
    return this.creditDecision;
  }

  async askUser(_prompt: string): Promise<string> {
    return "";
  }

  async confirmNextGroup(_groupLabel: string): Promise<boolean> {
    return true;
  }
}

class TestProgressSink extends ProgressSink {
  readonly activities: string[] = [];

  registerInterrupts(): InterruptHandler {
    return { onGuide: () => {}, onInterrupt: () => {}, onSkip: () => {}, onQuit: () => {} };
  }

  updateProgress(_update: ProgressUpdate): void {}

  setActivity(summary: string): void {
    this.activities.push(summary);
  }

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

const createPoolStateAccessor = (initial: OrchestratorState = {}) => {
  let state = initial;

  return {
    get: () => state,
    update: (fn: (value: OrchestratorState) => OrchestratorState) => {
      state = fn(state);
    },
  };
};

const createHarness = (opts?: {
  config?: Partial<OrchestratorConfig>;
  initialState?: OrchestratorState;
}) => {
  const config: OrchestratorConfig = { ...DEFAULT_CONFIG, ...opts?.config };
  const spawner = new FakeAgentSpawner();
  const poolStateAccessor = createPoolStateAccessor(opts?.initialState);
  const pool = new AgentPool(
    spawner,
    new FakeRolePromptResolver(),
    config,
    poolStateAccessor,
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
  const context = createPipelineContext({
    config,
    initialState: opts?.initialState,
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

  return {
    config,
    spawner,
    pool,
    interrupts,
    persistence,
    gate,
    progress,
    log,
    git,
    prompts,
    tierSelector,
    triager,
    context,
  };
};

const queueNowSequence = (...values: number[]) => {
  const spy = vi.spyOn(Date, "now");
  values.forEach((value) => {
    spy.mockReturnValueOnce(value);
  });
  return spy;
};

describe("createPipelineContext", () => {
  it("wraps mutable state and persists state transitions", async () => {
    const { context, persistence } = createHarness();

    context.state.set({ currentGroup: "Existing" });
    await context.state.advance({ kind: "sliceStarted", sliceNumber: 2, groupName: "Core" });

    expect(context.state.get().currentGroup).toBe("Core");
    expect(context.state.get().currentSlice).toBe(2);
    expect(persistence.current.currentGroup).toBe("Core");
    expect(persistence.current.currentSlice).toBe(2);
  });
});

describe("withRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns result on success", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("tdd");
    const result = okResult({ assistantText: "implemented" });
    const fn = vi.fn(async () => result);

    await expect(
      withRetry(fn, agent, "tdd", "TDD", {
        pool,
        interrupts,
        gate,
        progress,
        log,
        persistence,
        config,
        stateAccessor: context.state,
        minDurationMs: 0,
        delayMs: 0,
      }),
    ).resolves.toBe(result);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on dead respawnable agent", async () => {
    const { pool, spawner, interrupts, gate, progress, log, persistence, config, context } =
      createHarness();
    const firstAgent = await pool.ensure("tdd");
    let activeAgent = firstAgent;
    spawner.onNextSpawn("tdd", okResult({ assistantText: "fresh agent ready" }));

    const originalRespawn = pool.respawn.bind(pool);
    const respawnSpy = vi.spyOn(pool, "respawn").mockImplementation(async (role) => {
      const respawned = await originalRespawn(role);
      activeAgent = respawned;
      return respawned;
    });
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) {
        activeAgent.kill();
        return okResult({ assistantText: "died", sessionId: activeAgent.sessionId });
      }
      return okResult({ assistantText: "recovered", sessionId: activeAgent.sessionId });
    });

    const result = await withRetry(fn, firstAgent, "tdd", "verify", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence,
      config,
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
    });

    expect(result.assistantText).toBe("recovered");
    expect(respawnSpy).toHaveBeenCalledWith("tdd");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(spawner.agentsForRole("tdd")).toHaveLength(2);
  });

  it("throws on dead ephemeral agent", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("completeness");
    const fn = vi.fn(async () => {
      agent.kill();
      return okResult({ assistantText: "dead", sessionId: agent.sessionId });
    });

    await expect(
      withRetry(fn, agent, "completeness", "completeness", {
        pool,
        interrupts,
        gate,
        progress,
        log,
        persistence,
        config,
        stateAccessor: context.state,
        minDurationMs: 0,
        delayMs: 0,
      }),
    ).rejects.toThrow(IncompleteRunError);
  });

  it("returns immediately on dead agent with quit pending", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("verify");
    const respawnSpy = vi.spyOn(pool, "respawn");
    interrupts.requestQuit();
    const fn = vi.fn(async () => {
      agent.kill();
      return okResult({ assistantText: "quit requested", sessionId: agent.sessionId });
    });

    const result = await withRetry(fn, agent, "verify", "verify", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence,
      config,
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
    });

    expect(result.assistantText).toBe("quit requested");
    expect(respawnSpy).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns immediately on dead agent with hard interrupt pending", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("verify");
    const respawnSpy = vi.spyOn(pool, "respawn");
    interrupts.setHardInterrupt("Stop here");
    const fn = vi.fn(async () => {
      agent.kill();
      return okResult({ assistantText: "guided stop", sessionId: agent.sessionId });
    });

    const result = await withRetry(fn, agent, "verify", "verify", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence,
      config,
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
    });

    expect(result.assistantText).toBe("guided stop");
    expect(respawnSpy).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on too-fast return", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("tdd");
    queueNowSequence(0, 10, 20, 220);
    const fn = vi.fn(async () =>
      okResult({
        assistantText: fn.mock.calls.length === 1 ? "fast" : "steady",
        sessionId: agent.sessionId,
      }),
    );

    const result = await withRetry(fn, agent, "tdd", "TDD", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence,
      config,
      stateAccessor: context.state,
      minDurationMs: 100,
      delayMs: 0,
    });

    expect(result.assistantText).toBe("steady");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(progress.activities).toContain("agent returned too quickly (10ms), retrying 1/2...");
  });

  it("throws after max retries on repeated too-fast returns", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("tdd");
    queueNowSequence(0, 5, 10, 15);
    const fn = vi.fn(async () =>
      okResult({ assistantText: "still too fast", sessionId: agent.sessionId }),
    );

    await expect(
      withRetry(fn, agent, "tdd", "TDD", {
        pool,
        interrupts,
        gate,
        progress,
        log,
        persistence,
        config,
        stateAccessor: context.state,
        minDurationMs: 100,
        delayMs: 0,
        maxRetries: 1,
      }),
    ).rejects.toThrow(IncompleteRunError);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on retryable API error", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("tdd");
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) {
        return okResult({ exitCode: 1, resultText: "529 overloaded", sessionId: agent.sessionId });
      }
      return okResult({ assistantText: "recovered", sessionId: agent.sessionId });
    });

    const result = await withRetry(fn, agent, "tdd", "TDD", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence,
      config,
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
    });

    expect(result.assistantText).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(gate.creditCalls).toEqual([]);
    expect(progress.activities).toContain("waiting to retry (overloaded)...");
  });

  it("probes for usage availability in auto mode before retrying", async () => {
    const { pool, spawner, interrupts, gate, progress, log, persistence, context } = createHarness({
      config: { auto: true },
    });
    const agent = await pool.ensure("tdd");
    spawner.onNextSpawn("tdd", okResult({ exitCode: 1, resultText: "usage limit exceeded" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "OK" }));
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) {
        return okResult({
          exitCode: 1,
          resultText: "usage limit exceeded",
          sessionId: agent.sessionId,
        });
      }
      return okResult({ assistantText: "after probe", sessionId: agent.sessionId });
    });

    vi.useFakeTimers();
    const run = withRetry(fn, agent, "tdd", "TDD", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence,
      config: { ...DEFAULT_CONFIG, auto: true },
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
      usageProbeDelayMs: 1,
      usageProbeMaxDelayMs: 2,
    });
    await vi.advanceTimersByTimeAsync(3);
    const result = await run;

    expect(result.assistantText).toBe("after probe");
    expect(gate.creditCalls).toEqual([]);
    expect(spawner.agentsForRole("tdd")).toHaveLength(3);
  });

  it("stops probing for usage availability after quit is requested", async () => {
    const { pool, spawner, interrupts, gate, progress, log, context } = createHarness({
      config: { auto: true },
    });
    const agent = await pool.ensure("tdd");
    spawner.onNextSpawn("tdd", okResult({ exitCode: 1, resultText: "usage limit exceeded" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "OK" }));
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) {
        return okResult({
          exitCode: 1,
          resultText: "usage limit exceeded",
          sessionId: agent.sessionId,
        });
      }
      return okResult({ assistantText: "after probe", sessionId: agent.sessionId });
    });

    vi.useFakeTimers();
    const run = withRetry(fn, agent, "tdd", "TDD", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence: context.persistence,
      config: { ...DEFAULT_CONFIG, auto: true },
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
      usageProbeDelayMs: 1,
      usageProbeMaxDelayMs: 1,
    }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1);
    interrupts.requestQuit();
    await vi.advanceTimersByTimeAsync(2);
    await run;

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops probing for usage availability after a hard interrupt is requested", async () => {
    const { pool, spawner, interrupts, gate, progress, log, context } = createHarness({
      config: { auto: true },
    });
    const agent = await pool.ensure("tdd");
    spawner.onNextSpawn("tdd", okResult({ exitCode: 1, resultText: "usage limit exceeded" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "OK" }));
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) {
        return okResult({
          exitCode: 1,
          resultText: "usage limit exceeded",
          sessionId: agent.sessionId,
        });
      }
      return okResult({ assistantText: "after probe", sessionId: agent.sessionId });
    });

    vi.useFakeTimers();
    const run = withRetry(fn, agent, "tdd", "TDD", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence: context.persistence,
      config: { ...DEFAULT_CONFIG, auto: true },
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
      usageProbeDelayMs: 1,
      usageProbeMaxDelayMs: 1,
    }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1);
    interrupts.setHardInterrupt("stop probing");
    await vi.advanceTimersByTimeAsync(2);
    await run;

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gates to operator on non-retryable error when auto mode is disabled", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("tdd");
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) {
        return okResult({
          exitCode: 1,
          resultText: "usage limit exceeded for this billing period",
          sessionId: agent.sessionId,
        });
      }
      return okResult({ assistantText: "retried", sessionId: agent.sessionId });
    });

    const result = await withRetry(fn, agent, "tdd", "TDD", {
      pool,
      interrupts,
      gate,
      progress,
      log,
      persistence,
      config,
      stateAccessor: context.state,
      minDurationMs: 0,
      delayMs: 0,
    });

    expect(result.assistantText).toBe("retried");
    expect(gate.creditCalls).toHaveLength(1);
    expect(gate.creditCalls[0]?.label).toBe("TDD");
  });

  it("throws after repeated dead respawns exhaust maxRetries", async () => {
    const { pool, spawner, interrupts, gate, progress, log, persistence, config, context } =
      createHarness();
    const firstAgent = await pool.ensure("tdd");
    let activeAgent = firstAgent;
    spawner.onNextSpawn("tdd", okResult({ assistantText: "respawn one" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "respawn two" }));

    const originalRespawn = pool.respawn.bind(pool);
    vi.spyOn(pool, "respawn").mockImplementation(async (role) => {
      const respawned = await originalRespawn(role);
      activeAgent = respawned;
      return respawned;
    });
    const fn = vi.fn(async () => {
      activeAgent.kill();
      return okResult({ assistantText: "died again", sessionId: activeAgent.sessionId });
    });

    await expect(
      withRetry(fn, firstAgent, "tdd", "verify", {
        pool,
        interrupts,
        gate,
        progress,
        log,
        persistence,
        config,
        stateAccessor: context.state,
        minDurationMs: 0,
        delayMs: 0,
        maxRetries: 1,
      }),
    ).rejects.toThrow(IncompleteRunError);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after repeated retryable API errors exhaust maxRetries", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("tdd");
    const fn = vi.fn(async () =>
      okResult({ exitCode: 1, resultText: "529 overloaded", sessionId: agent.sessionId }),
    );

    await expect(
      withRetry(fn, agent, "tdd", "TDD", {
        pool,
        interrupts,
        gate,
        progress,
        log,
        persistence,
        config,
        stateAccessor: context.state,
        minDurationMs: 0,
        delayMs: 0,
        maxRetries: 1,
      }),
    ).rejects.toThrow(IncompleteRunError);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws CreditExhaustedError when operator quits", async () => {
    const { pool, interrupts, gate, progress, log, persistence, config, context } = createHarness();
    const agent = await pool.ensure("tdd");
    gate.creditDecision = { kind: "quit" };
    const fn = vi.fn(async () =>
      okResult({
        exitCode: 1,
        assistantText: "You've hit your limit",
        resultText: "",
        sessionId: agent.sessionId,
      }),
    );

    await expect(
      withRetry(fn, agent, "tdd", "TDD", {
        pool,
        interrupts,
        gate,
        progress,
        log,
        persistence,
        config,
        stateAccessor: context.state,
        minDurationMs: 0,
        delayMs: 0,
      }),
    ).rejects.toThrow(CreditExhaustedError);

    expect(gate.creditCalls).toHaveLength(1);
  });
});
