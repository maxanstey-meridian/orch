import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPool } from "#application/agent-pool.js";
import { createInterruptState } from "#application/interrupt-state.js";
import { createPipelineContext } from "#application/pipeline-context.js";
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
import { executeGroups } from "#application/pipeline/execution-router.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import type { ExecutionMode, OrchestratorConfig, SkillSet } from "#domain/config.js";
import type { Group, Slice } from "#domain/plan.js";
import type { OrchestratorState } from "#domain/state.js";
import type { BoundaryTriageResult } from "#domain/triage.js";
import { FakeAgentSpawner } from "../../fakes/fake-agent-spawner.js";
import { FakeExecutionUnitTierSelector } from "../../fakes/fake-execution-unit-tier-selector.js";
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
  planContent: "direct request content",
  brief: "brief",
  executionMode: "sliced",
  executionPreference: "auto",
  auto: true,
  reviewThreshold: 30,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  logPath: null,
  tier: "medium",
  skills: DEFAULT_SKILLS,
  maxReplans: 2,
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
  readonly confirmNextGroupLabels: string[] = [];

  constructor(
    private readonly answers: {
      readonly plan?: GateDecision;
      readonly verify?: VerifyDecision;
      readonly credit?: CreditDecision;
      readonly nextGroup?: boolean;
    } = {},
  ) {
    super();
  }

  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    return this.answers.plan ?? { kind: "accept" };
  }

  async verifyFailed(
    _executionUnitLabel: string,
    _summary: string,
    _retryable: boolean,
  ): Promise<VerifyDecision> {
    return this.answers.verify ?? { kind: "stop" };
  }

  async creditExhausted(_label: string, _message: string): Promise<CreditDecision> {
    return this.answers.credit ?? { kind: "retry" };
  }

  async askUser(_prompt: string): Promise<string> {
    return "";
  }

  async confirmNextGroup(groupLabel: string): Promise<boolean> {
    this.confirmNextGroupLabels.push(groupLabel);
    return this.answers.nextGroup ?? true;
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

class TestExecutionUnitTriager extends ExecutionUnitTriager {
  readonly inputs = [] as Parameters<ExecutionUnitTriager["decide"]>[0][];
  private readonly queued: BoundaryTriageResult[] = [];

  queueResult(...results: BoundaryTriageResult[]): void {
    this.queued.push(...results);
  }

  async decide(input: Parameters<ExecutionUnitTriager["decide"]>[0]): Promise<BoundaryTriageResult> {
    this.inputs.push(input);
    return this.queued.shift() ?? {
      completeness: "skip",
      verify: "skip",
      review: "skip",
      gap: "skip",
      reason: "test default",
    };
  }
}

const makeSlice = (number: number, groupLabel = "Core"): Slice => ({
  number,
  title: `${groupLabel} Slice ${number}`,
  content: `Content ${number}`,
  why: "why",
  files: [],
  details: "details",
  tests: "tests",
});

const makeGroup = (name: string, ...numbers: number[]): Group => ({
  name,
  slices: numbers.map((number) => makeSlice(number, name)),
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

type TestConfig = Omit<Partial<OrchestratorConfig>, "skills"> & {
  readonly skills?: Partial<SkillSet>;
};

const createHarness = (options?: {
  readonly config?: TestConfig;
  readonly state?: OrchestratorState;
}) => {
  const config: OrchestratorConfig = {
    ...DEFAULT_CONFIG,
    ...(options?.config ?? {}),
    skills: {
      ...DEFAULT_SKILLS,
      ...(options?.config?.skills ?? {}),
    },
  };

  const spawner = new FakeAgentSpawner();
  const prompts = new PassthroughPromptBuilder();
  const persistence = new InMemoryStatePersistence();
  const git = new InMemoryGitOps();
  const gate = new TestOperatorGate();
  const progress = new TestProgressSink();
  const log = new FakeLogWriter();
  const triager = new TestExecutionUnitTriager();
  const tierSelector = new FakeExecutionUnitTierSelector();
  const pool = new AgentPool(
    spawner,
    new FakeRolePromptResolver(),
    config,
    createPoolStateAccessor(options?.state ?? {}),
    () => {},
    (role) => `[RULES:${role}]`,
  );

  if (options?.state) {
    persistence.current = options.state;
  }

  const ctx = createPipelineContext({
    config,
    initialState: options?.state,
    git,
    persistence,
    progress,
    log,
    prompts,
    gate,
    pool,
    interrupts: createInterruptState(),
    triager,
    tierSelector,
    retryDelayMs: 0,
    minAgentDurationMs: 0,
    usageProbeDelayMs: 0,
    usageProbeMaxDelayMs: 0,
  });

  return {
    ctx,
    spawner,
    prompts,
    persistence,
    git,
    gate,
    triager,
    tierSelector,
    pool,
  };
};

const verifyPass = (): string => `### VERIFY_JSON
\`\`\`json
${JSON.stringify({
  status: "PASS",
  checks: [],
  sliceLocalFailures: [],
  outOfScopeFailures: [],
  preExistingFailures: [],
  runnerIssue: null,
  retryable: false,
  summary: "ok",
}, null, 2)}
\`\`\``;

describe("executeGroups", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("direct mode: runs execute and final passes", async () => {
    const { ctx, spawner, prompts, triager } = createHarness({
      config: {
        executionMode: "direct",
        skills: { completeness: null, verify: null, review: null, gap: null, plan: null },
      },
    });
    prompts.directFinalPassesOverride = [{ name: "sanity", prompt: "final pass" }];
    triager.queueResult({
      completeness: "skip",
      verify: "skip",
      review: "skip",
      gap: "skip",
      reason: "skip boundary",
    });
    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "implemented direct request" }),
      okResult({ assistantText: "ran direct test pass" }),
    );
    spawner.onNextSpawn("final", okResult({ assistantText: "NO_ISSUES_FOUND" }));

    await executeGroups([makeGroup("G1", 1)], ctx);

    const tdd = spawner.lastAgent("tdd");
    expect(tdd.sentPrompts[0]).toContain("[DIRECT] direct request content");
    expect(tdd.sentPrompts[1]).toContain("[DIRECT_TEST_PASS] direct request content");
    expect(spawner.agentsForRole("final")).toHaveLength(1);
  });

  it("sliced mode: iterates slices in order", async () => {
    const { ctx, spawner } = createHarness({
      config: {
        skills: { plan: null, verify: null, review: null, gap: null, completeness: null },
      },
    });
    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "slice 1 done" }),
      okResult({ assistantText: "slice 2 done" }),
    );

    await executeGroups([makeGroup("Core", 1, 2)], ctx);

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual([
      expect.stringContaining("[TDD:1]"),
      expect.stringContaining("[TDD:2]"),
    ]);
  });

  it("sliced mode: skips completed slices", async () => {
    const { ctx, spawner } = createHarness({
      config: {
        skills: { plan: null, verify: null, review: null, gap: null, completeness: null },
      },
      state: { lastCompletedSlice: 1 },
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 2 done" }));

    await executeGroups([makeGroup("Core", 1, 2)], ctx);

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual([expect.stringContaining("[TDD:2]")]);
  });

  it("sliced mode: skips completed groups", async () => {
    const { ctx, spawner } = createHarness({
      config: {
        skills: { plan: null, verify: null, review: null, gap: null, completeness: null },
      },
      state: { lastCompletedGroup: "G1", lastCompletedSlice: 2 },
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "slice 3 done" }));

    await executeGroups([makeGroup("G1", 1, 2), makeGroup("G2", 3)], ctx);

    expect(spawner.lastAgent("tdd").sentPrompts).toEqual([expect.stringContaining("[TDD:3]")]);
  });

  it("grouped mode: runs grouped execute with test pass", async () => {
    const { ctx, spawner, triager } = createHarness({
      config: {
        executionMode: "grouped",
        skills: { verify: null, review: null, gap: null, completeness: null, plan: null },
      },
    });
    triager.queueResult({
      completeness: "skip",
      verify: "skip",
      review: "skip",
      gap: "skip",
      reason: "skip boundary",
    });
    spawner.onNextSpawn(
      "tdd",
      okResult({ assistantText: "group done" }),
      okResult({ assistantText: "tests done" }),
    );

    await executeGroups([makeGroup("Core", 1, 2)], ctx);

    expect(spawner.lastAgent("tdd").sentPrompts[0]).toContain("[GROUP_EXEC:Core]");
    expect(spawner.lastAgent("tdd").sentPrompts[1]).toContain("[GROUP_TEST_PASS:Core]");
  });

  it("boundary policy: runs verify when triage says run_now", async () => {
    const { ctx, spawner, triager } = createHarness({
      config: {
        skills: { plan: null, review: null, gap: null, completeness: null },
      },
    });
    triager.queueResult({
      completeness: "skip",
      verify: "run_now",
      review: "skip",
      gap: "skip",
      reason: "verify now",
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: verifyPass() }));

    await executeGroups([makeGroup("Core", 1)], ctx);

    expect(spawner.agentsForRole("verify")).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("[VERIFY:1]");
  });

  it("boundary policy: defers verify when triage says defer", async () => {
    const { ctx, spawner, triager, git } = createHarness({
      config: {
        skills: { plan: null, review: null, gap: null, completeness: null },
      },
    });
    git.setHasChanges(true);
    triager.queueResult({
      completeness: "skip",
      verify: "defer",
      review: "skip",
      gap: "skip",
      reason: "defer verify",
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));
    spawner.onNextSpawn("verify", okResult({ assistantText: verifyPass() }));

    await executeGroups([makeGroup("Core", 1)], ctx);

    expect(spawner.agentsForRole("verify")).toHaveLength(1);
    expect(spawner.lastAgent("verify").sentPrompts[0]).toContain("[GROUP_VERIFY:Core]");
    expect(spawner.lastAgent("verify").sentPrompts[0]).not.toContain("[VERIFY:1]");
  });

  it("boundary policy: skips verify when triage says skip", async () => {
    const { ctx, spawner, triager } = createHarness({
      config: {
        skills: { plan: null, review: null, gap: null, completeness: null },
      },
    });
    triager.queueResult({
      completeness: "skip",
      verify: "skip",
      review: "skip",
      gap: "skip",
      reason: "skip verify",
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented" }));

    await executeGroups([makeGroup("Core", 1)], ctx);

    expect(spawner.agentsForRole("verify")).toHaveLength(0);
  });

  it("inter-group: respawns agents between groups", async () => {
    const { ctx, spawner } = createHarness({
      config: {
        skills: { plan: null, verify: null, review: null, gap: null, completeness: null },
      },
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "group 1 done" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "group 2 done" }));

    await executeGroups([makeGroup("G1", 1), makeGroup("G2", 2)], ctx);

    expect(spawner.agentsForRole("tdd")).toHaveLength(2);
    expect(spawner.agentsForRole("tdd")[0].alive).toBe(false);
  });

  it("inter-group: confirms next group in non-auto mode", async () => {
    const { ctx, spawner, gate } = createHarness({
      config: {
        auto: false,
        skills: { plan: null, verify: null, review: null, gap: null, completeness: null },
      },
    });
    spawner.onNextSpawn("tdd", okResult({ assistantText: "group 1 done" }));
    spawner.onNextSpawn("tdd", okResult({ assistantText: "group 2 done" }));

    await executeGroups([makeGroup("G1", 1), makeGroup("G2", 2)], ctx);

    expect(gate.confirmNextGroupLabels).toEqual(["G1"]);
  });

  it("quit requested: exits loop early", async () => {
    const { ctx, spawner, persistence } = createHarness({
      config: {
        skills: { plan: null, verify: null, review: null, gap: null, completeness: null },
      },
    });
    spawner.onNextSpawn(
      "tdd",
      () => {
        ctx.interrupts.requestQuit();
        return okResult({ assistantText: "group 1 done" });
      },
      okResult({ assistantText: "group 2 done" }),
    );

    await executeGroups([makeGroup("G1", 1), makeGroup("G1", 2)], ctx);

    expect(spawner.lastAgent("tdd").sentPrompts).toHaveLength(1);
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
  });

  it("skip requested: skips current slice", async () => {
    const { ctx, spawner, persistence } = createHarness({
      config: {
        skills: { verify: null, review: null, gap: null, completeness: null },
      },
    });
    spawner.onNextSpawn("plan", () => {
      ctx.interrupts.toggleSkip();
      return okResult({ assistantText: "plan", planText: "plan text" });
    });

    await executeGroups([makeGroup("G1", 1)], ctx);

    expect(spawner.agentsForRole("tdd")).toHaveLength(0);
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
  });
});
