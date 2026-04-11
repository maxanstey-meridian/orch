import { AgentPool } from "#application/agent-pool.js";
import { createInterruptState, type InterruptState } from "#application/interrupt-state.js";
import {
  createPipelineContext,
  type PipelineContext,
  type StateAccessor,
} from "#application/pipeline-context.js";
import { executeGroups } from "#application/pipeline/execution-router.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { AgentResult } from "#domain/agent-types.js";
import type { OrchestratorConfig, SkillSet } from "#domain/config.js";
import { IncompleteRunError } from "#domain/errors.js";
import type { Group } from "#domain/plan.js";
import type { OrchestratorState } from "#domain/state.js";
import { InkOperatorGate } from "#infrastructure/gate/ink-operator-gate.js";
import { SilentOperatorGate } from "#infrastructure/gate/silent-operator-gate.js";
import { InkProgressSink } from "#infrastructure/progress/ink-progress-sink.js";
import { FakeAgentSpawner } from "./fake-agent-spawner.js";
import { InMemoryGitOps } from "./fake-git-ops.js";
import { FakeHud } from "./fake-hud.js";
import { FakeExecutionUnitTierSelector } from "./fake-execution-unit-tier-selector.js";
import { FakeExecutionUnitTriager } from "./fake-execution-unit-triager.js";
import { FakeLogWriter } from "./fake-log-writer.js";
import { PassthroughPromptBuilder } from "./fake-prompt-builder.js";
import { FakeRolePromptResolver } from "./fake-role-prompt-resolver.js";
import { InMemoryStatePersistence } from "./fake-state-persistence.js";

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

/** Standard successful AgentResult. Override fields as needed. */
export const okResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test-session",
  ...overrides,
});

type TestConfig = Omit<Partial<OrchestratorConfig>, "skills"> & { skills?: Partial<SkillSet> };

class TestPipelineExecutor {
  retryDelayMs = 0;
  minAgentDurationMs = 0;
  usageProbeDelayMs: number | undefined;
  usageProbeMaxDelayMs: number | undefined;
  quitRequested = false;
  sliceSkipFlag = false;
  hardInterruptPending: string | null = null;

  ctx!: PipelineContext;
  pool!: AgentPool;
  interrupts!: InterruptState;
  progressSink!: InkProgressSink;
  gate!: InkOperatorGate | SilentOperatorGate;

  readonly #initialState: OrchestratorState;
  readonly #config: OrchestratorConfig;
  readonly #auto: boolean;
  readonly #hud: FakeHud;
  readonly #spawner: FakeAgentSpawner;
  readonly #persistence: InMemoryStatePersistence;
  readonly #git: InMemoryGitOps;
  readonly #prompts: PassthroughPromptBuilder;
  readonly #logWriter: FakeLogWriter;
  readonly #rolePromptResolver: FakeRolePromptResolver;
  readonly #tierSelector: FakeExecutionUnitTierSelector;
  readonly #triager: FakeExecutionUnitTriager;
  #currentState: OrchestratorState;

  constructor(params: {
    readonly initialState: OrchestratorState;
    readonly config: OrchestratorConfig;
    readonly auto: boolean;
    readonly hud: FakeHud;
    readonly spawner: FakeAgentSpawner;
    readonly persistence: InMemoryStatePersistence;
    readonly git: InMemoryGitOps;
    readonly prompts: PassthroughPromptBuilder;
    readonly logWriter: FakeLogWriter;
    readonly rolePromptResolver: FakeRolePromptResolver;
    readonly tierSelector: FakeExecutionUnitTierSelector;
    readonly triager: FakeExecutionUnitTriager;
  }) {
    this.#initialState = params.initialState;
    this.#config = params.config;
    this.#auto = params.auto;
    this.#hud = params.hud;
    this.#spawner = params.spawner;
    this.#persistence = params.persistence;
    this.#git = params.git;
    this.#prompts = params.prompts;
    this.#logWriter = params.logWriter;
    this.#rolePromptResolver = params.rolePromptResolver;
    this.#tierSelector = params.tierSelector;
    this.#triager = params.triager;
    this.#currentState = this.#bootstrapState(params.initialState);

    this.#buildPipeline();
  }

  async execute(groups: readonly Group[]): Promise<void> {
    this.quitRequested = false;
    this.sliceSkipFlag = false;
    this.hardInterruptPending = null;
    this.#currentState = this.#bootstrapState(await this.#persistence.load());
    this.#buildPipeline();

    try {
      await this.pool.prewarmLongLived();
      await executeGroups(groups, this.ctx);
      this.ctx.progress.clearSkipping();

      const completedState: OrchestratorState = {
        ...this.ctx.state.get(),
        executionMode: this.#config.executionMode,
        currentPhase: undefined,
        completedAt: new Date().toISOString(),
      };
      this.ctx.state.set(completedState);
      await this.#persistence.save(completedState);

      this.#currentState = completedState;
      this.hardInterruptPending = this.interrupts.hardInterrupt();

      if (this.interrupts.skipRequested()) {
        const currentGroup = this.#currentState.currentGroup ?? groups[0]?.name ?? "current";
        const currentSlice = this.#currentState.currentSlice ?? groups[0]?.slices[0]?.number ?? 1;
        this.sliceSkipFlag = false;
        throw new IncompleteRunError(`Skipped ${currentGroup} slice ${currentSlice}`);
      }
    } catch (error) {
      this.ctx.progress.clearSkipping();
      const message = error instanceof Error ? error.message : String(error);
      this.#logOrchestrator(`Execution failed: ${message}`);
      throw error;
    } finally {
      await this.#logWriter.close();
    }
  }

  #buildPipeline(): void {
    const interrupts = createInterruptState();
    const progressSink = new InkProgressSink(this.#hud, { planningDelayMs: 0 });
    const gate = this.#auto ? new SilentOperatorGate() : new InkOperatorGate(this.#hud);
    const interruptHandler = progressSink.registerInterrupts();
    const initialState = this.#currentState;

    let context: PipelineContext | null = null;
    const poolStateAccessor: StateAccessor & { readonly update: (fn: (state: OrchestratorState) => OrchestratorState) => void } = {
      get: () => (context === null ? this.#currentState : context.state.get()),
      set: (state: OrchestratorState) => {
        this.#currentState = state;
        if (context !== null) {
          context.state.set(state);
        }
      },
      advance: async (event) => {
        const current = context === null ? this.#currentState : context.state.get();
        const next = { ...current };
        void event;
        this.#currentState = next;
      },
      update: (update) => {
        const next = update(context === null ? this.#currentState : context.state.get());
        this.#currentState = next;
        if (context !== null) {
          context.state.set(next);
        }
      },
    };

    const pool = new AgentPool(
      this.#spawner,
      this.#rolePromptResolver,
      this.#config,
      {
        get: poolStateAccessor.get,
        update: poolStateAccessor.update,
      },
      (handle, role) => {
        handle.pipe(
          (text) => {
            this.#logWriter.write(role, text);
          },
          () => {},
        );
      },
      (role) => this.#prompts.rulesReminder(role),
    );

    interruptHandler.onSkip(() => {
      const state = context === null ? this.#currentState : context.state.get();
      if (state.currentPhase === undefined) {
        return false;
      }

      this.sliceSkipFlag = interrupts.toggleSkip();
      return this.sliceSkipFlag;
    });
    interruptHandler.onQuit(() => {
      interrupts.requestQuit();
      this.quitRequested = true;
    });
    interruptHandler.onInterrupt((guidance) => {
      interrupts.setHardInterrupt(guidance);
      this.hardInterruptPending = guidance;
    });
    interruptHandler.onGuide((guidance) => {
      this.hardInterruptPending = null;
      void pool.inject("tdd", guidance);
    });

    const baseContext = createPipelineContext({
      config: this.#config,
      initialState,
      git: this.#git,
      persistence: this.#persistence,
      progress: progressSink,
      log: this.#logWriter,
      prompts: this.#prompts,
      gate,
      pool,
      interrupts,
      triager: this.#triager,
      tierSelector: this.#tierSelector,
      retryDelayMs: this.retryDelayMs,
      minAgentDurationMs: this.minAgentDurationMs,
      usageProbeDelayMs: this.usageProbeDelayMs,
      usageProbeMaxDelayMs: this.usageProbeMaxDelayMs,
    });

    context = {
      ...baseContext,
      progress: {
        registerInterrupts: () => baseContext.progress.registerInterrupts(),
        updateProgress: (update) => baseContext.progress.updateProgress(update),
        setActivity: (summary) => baseContext.progress.setActivity(summary),
        log: (text) => baseContext.progress.log(text),
        logExecutionMode: (executionMode) => baseContext.progress.logExecutionMode(executionMode),
        createStreamer: (role) => {
          const progressStreamer = baseContext.progress.createStreamer(role);
          return (text: string) => {
            progressStreamer(text);
            this.#logWriter.write(role, text);
          };
        },
        logSliceIntro: (slice) => baseContext.progress.logSliceIntro(slice),
        logBadge: (role, phase) => baseContext.progress.logBadge(role, phase),
        clearSkipping: () => baseContext.progress.clearSkipping(),
        teardown: () => baseContext.progress.teardown(),
      },
      state: {
        get: () => baseContext.state.get(),
        set: (state) => {
          this.#currentState = state;
          baseContext.state.set(state);
        },
        advance: async (event) => {
          switch (event.kind) {
            case "sliceStarted":
              this.#logOrchestrator(`Starting slice ${event.sliceNumber} (${event.groupName})`);
              break;
            case "phaseEntered":
              this.#logOrchestrator(`Entered phase ${event.phase} for slice ${event.sliceNumber}`);
              break;
            case "sliceDone":
              this.#logOrchestrator(`Completed slice ${event.sliceNumber}`);
              break;
          }

          await baseContext.state.advance(event);
          this.#currentState = baseContext.state.get();
        },
      },
    };

    this.ctx = context;
    this.pool = pool;
    this.interrupts = interrupts;
    this.progressSink = progressSink;
    this.gate = gate;
  }

  #bootstrapState(state: OrchestratorState): OrchestratorState {
    const normalized: OrchestratorState = {
      ...state,
      executionMode: this.#config.executionMode,
      tier: state.tier ?? state.activeTier ?? this.#config.tier,
      activeTier: state.activeTier ?? state.tier ?? this.#config.tier,
    };

    if (this.#config.executionMode !== "direct") {
      return normalized;
    }

    return {
      ...normalized,
      currentPhase: undefined,
      currentSlice: undefined,
      currentGroup: undefined,
      currentGroupBaseSha: undefined,
      sliceTimings: undefined,
      lastCompletedSlice: undefined,
      lastCompletedGroup: undefined,
      lastSliceImplemented: undefined,
      reviewBaseSha: undefined,
      pendingVerifyBaseSha: undefined,
      pendingCompletenessBaseSha: undefined,
      pendingReviewBaseSha: undefined,
      pendingGapBaseSha: undefined,
    };
  }

  #logOrchestrator(text: string): void {
    this.#logWriter.write("ORCH", text);
  }
}

export type TestHarness = ReturnType<typeof createTestHarness>;

export const createTestHarness = (opts?: {
  config?: TestConfig;
  state?: OrchestratorState;
  auto?: boolean;
}) => {
  const hud = new FakeHud();
  const spawner = new FakeAgentSpawner();
  const persistence = new InMemoryStatePersistence();
  const git = new InMemoryGitOps();
  const prompts = new PassthroughPromptBuilder();
  const logWriter = new FakeLogWriter();
  const rolePromptResolver = new FakeRolePromptResolver();
  const tierSelector = new FakeExecutionUnitTierSelector();
  const triager = new FakeExecutionUnitTriager(spawner);

  const { skills: skillOverrides, ...configRest } = opts?.config ?? {};
  const config: OrchestratorConfig = {
    ...DEFAULT_CONFIG,
    ...configRest,
    skills: { ...DEFAULT_SKILLS, ...skillOverrides },
    ...(opts?.auto === undefined ? {} : { auto: opts.auto }),
  };

  if (opts?.state) {
    persistence.current = opts.state;
  }

  const initialState = opts?.state ?? {};
  const executor = new TestPipelineExecutor({
    initialState,
    config,
    auto: opts?.auto ?? config.auto,
    hud,
    spawner,
    persistence,
    git,
    prompts,
    logWriter,
    rolePromptResolver,
    tierSelector,
    triager,
  });

  const execute = async (groups: readonly Group[]): Promise<void> => executor.execute(groups);

  return {
    uc: executor,
    execute,
    executeGroups,
    get ctx(): PipelineContext {
      return executor.ctx;
    },
    get pool(): AgentPool {
      return executor.pool;
    },
    get interrupts(): InterruptState {
      return executor.interrupts;
    },
    get progressSink(): InkProgressSink {
      return executor.progressSink;
    },
    get gate(): InkOperatorGate | SilentOperatorGate {
      return executor.gate;
    },
    hud,
    spawner,
    persistence,
    git,
    prompts,
    config,
    logWriter,
    rolePromptResolver,
    tierSelector,
    triager,
  };
};
