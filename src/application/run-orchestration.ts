import { AgentPool } from "#application/agent-pool.js";
import { createInterruptState } from "#application/interrupt-state.js";
import { createPipelineContext } from "#application/pipeline-context.js";
import type { AgentSpawner } from "#application/ports/agent-spawner.port.js";
import type { ExecutionUnitTierSelector } from "#application/ports/execution-unit-tier-selector.port.js";
import type { ExecutionUnitTriager } from "#application/ports/execution-unit-triager.port.js";
import type { GitOps } from "#application/ports/git-ops.port.js";
import type { LogWriter } from "#application/ports/log-writer.port.js";
import type { OperatorGate } from "#application/ports/operator-gate.port.js";
import type { ProgressSink } from "#application/ports/progress-sink.port.js";
import type { PromptBuilder } from "#application/ports/prompt-builder.port.js";
import type { RolePromptResolver } from "#application/ports/role-prompt-resolver.port.js";
import type { StatePersistence } from "#application/ports/state-persistence.port.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { IncompleteRunError } from "#domain/errors.js";
import type { Group } from "#domain/plan.js";
import type { OrchestratorState } from "#domain/state.js";
import { executeGroups } from "./pipeline/execution-router.js";

export class RunOrchestration {
  static inject = [
    "agentSpawner",
    "statePersistence",
    "operatorGate",
    "gitOps",
    "promptBuilder",
    "config",
    "progressSink",
    "logWriter",
    "rolePromptResolver",
    "executionUnitTierSelector",
    "executionUnitTriager",
  ] as const;

  state: OrchestratorState = {};
  retryDelayMs = 5_000;
  minAgentDurationMs = 3_000;
  usageProbeDelayMs = 60_000;
  usageProbeMaxDelayMs = 300_000;
  sliceSkipFlag = false;
  quitRequested = false;
  hardInterruptPending: string | null = null;

  constructor(
    private readonly agents: AgentSpawner,
    private readonly persistence: StatePersistence,
    private readonly gate: OperatorGate,
    private readonly git: GitOps,
    private readonly prompts: PromptBuilder,
    private readonly config: OrchestratorConfig,
    private readonly progressSink: ProgressSink,
    private readonly logWriter: LogWriter,
    private readonly rolePromptResolver: RolePromptResolver,
    private readonly tierSelector: ExecutionUnitTierSelector,
    private readonly triager: ExecutionUnitTriager,
  ) {}

  private logOrchestrator(text: string): void {
    this.logWriter.write("ORCH", text);
  }

  private bootstrapState(state: OrchestratorState): OrchestratorState {
    const normalized: OrchestratorState = {
      ...state,
      executionMode: this.config.executionMode,
      tier: state.tier ?? state.activeTier ?? this.config.tier,
      activeTier: state.activeTier ?? state.tier ?? this.config.tier,
    };

    if (this.config.executionMode !== "direct") {
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

  async execute(groups: readonly Group[]): Promise<void> {
    this.state = this.bootstrapState(await this.persistence.load());

    const interrupts = createInterruptState();
    const interruptHandler = this.progressSink.registerInterrupts();
    interruptHandler.onSkip(() => {
      const currentState = ctx === null ? ctxState : ctx.state.get();
      if (currentState.currentPhase === undefined) {
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

    let ctxState: OrchestratorState = this.state;
    let ctx:
      | ReturnType<typeof createPipelineContext>
      | null = null;

    const pool = new AgentPool(
      this.agents,
      this.rolePromptResolver,
      this.config,
      {
        get: () => (ctx === null ? ctxState : ctx.state.get()),
        update: (update) => {
          ctxState = update(ctx === null ? ctxState : ctx.state.get());
          if (ctx !== null) {
            ctx.state.set(ctxState);
          }
        },
      },
      (handle, role) => {
        handle.pipe(
          (text) => {
            this.logWriter.write(role, text);
          },
          () => {},
        );
      },
      (role) => this.prompts.rulesReminder(role),
    );

    const baseContext = createPipelineContext({
      config: this.config,
      initialState: ctxState,
      git: this.git,
      persistence: this.persistence,
      progress: this.progressSink,
      log: this.logWriter,
      prompts: this.prompts,
      gate: this.gate,
      pool,
      interrupts,
      triager: this.triager,
      tierSelector: this.tierSelector,
      retryDelayMs: this.retryDelayMs,
      minAgentDurationMs: this.minAgentDurationMs,
      usageProbeDelayMs: this.usageProbeDelayMs,
      usageProbeMaxDelayMs: this.usageProbeMaxDelayMs,
    });

    ctx = {
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
            this.logWriter.write(role, text);
          };
        },
        logSliceIntro: (slice) => baseContext.progress.logSliceIntro(slice),
        logBadge: (role, phase) => baseContext.progress.logBadge(role, phase),
        clearSkipping: () => baseContext.progress.clearSkipping(),
        teardown: () => baseContext.progress.teardown(),
      },
      state: {
        get: () => baseContext.state.get(),
        set: (state) => baseContext.state.set(state),
        advance: async (event) => {
          switch (event.kind) {
            case "sliceStarted":
              this.logOrchestrator(`Starting slice ${event.sliceNumber} (${event.groupName})`);
              break;
            case "phaseEntered":
              this.logOrchestrator(`Entered phase ${event.phase} for slice ${event.sliceNumber}`);
              break;
            case "sliceDone":
              this.logOrchestrator(`Completed slice ${event.sliceNumber}`);
              break;
          }

          await baseContext.state.advance(event);
        },
      },
    };

    try {
      await pool.prewarmLongLived();
      await executeGroups(groups, ctx);

      const completedState: OrchestratorState = {
        ...ctx.state.get(),
        executionMode: this.config.executionMode,
        currentPhase: undefined,
        completedAt: new Date().toISOString(),
      };
      ctx.state.set(completedState);
      await this.persistence.save(completedState);

      this.state = completedState;
      this.hardInterruptPending = interrupts.hardInterrupt();

      if (interrupts.skipRequested()) {
        const currentGroup = this.state.currentGroup ?? groups[0]?.name ?? "current";
        const currentSlice = this.state.currentSlice ?? groups[0]?.slices[0]?.number ?? 1;
        this.sliceSkipFlag = false;
        throw new IncompleteRunError(`Skipped ${currentGroup} slice ${currentSlice}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logOrchestrator(`Execution failed: ${message}`);
      throw error;
    } finally {
      await this.logWriter.close();
    }
  }
}
