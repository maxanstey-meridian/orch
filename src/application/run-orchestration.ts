import { AgentPool } from "#application/agent-pool.js";
import { createInterruptState } from "#application/interrupt-state.js";
import { directUnit, groupedUnit, sliceUnit, type ExecutionUnit } from "#application/execution-unit.js";
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
import { isCleanReview } from "#domain/review-check.js";
import { pipelineRunner } from "./pipeline/pipeline-runner.js";
import type { PhaseHandler } from "./pipeline/phase-handler.js";

const makePhases = (
  unit: ExecutionUnit,
  prompts: PromptBuilder,
  baseSha: string,
  maxCycles: number,
): readonly PhaseHandler[] => [
  {
    name: "execute",
    persistedPhase: "tdd",
    agent: "tdd",
    prompt: (currentUnit) => {
      switch (currentUnit.kind) {
        case "direct":
          return prompts.directExecute(currentUnit.content);
        case "group":
          return prompts.groupedExecute(currentUnit.groupName, currentUnit.content, false);
        case "slice":
          return prompts.tdd(currentUnit.content, undefined, currentUnit.sliceNumber);
      }
    },
    isClean: () => true,
  },
  {
    name: "review",
    persistedPhase: "review",
    agent: "review",
    prompt: (currentUnit) => {
      switch (currentUnit.kind) {
        case "direct":
          return prompts.directReview(currentUnit.content, baseSha);
        case "group":
        case "slice":
          return prompts.review(currentUnit.content, baseSha);
      }
    },
    isClean: (result) => isCleanReview(result.assistantText),
    fixPrompt: (currentUnit, findings) =>
      prompts.tdd(currentUnit.content, findings, currentUnit.sliceNumber),
    maxCycles,
  },
];

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

  async execute(groups: readonly Group[]): Promise<void> {
    this.state = await this.persistence.load();

    const interrupts = createInterruptState();
    const interruptHandler = this.progressSink.registerInterrupts();
    interruptHandler.onSkip(() => {
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
      interrupts.setHardInterrupt(guidance);
      this.hardInterruptPending = guidance;
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
      () => {},
      (role) => this.prompts.rulesReminder(role),
    );

    ctx = createPipelineContext({
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
    });

    const executeUnit = async (unit: ExecutionUnit): Promise<void> => {
      const baseSha = await this.git.captureRef();
      const phases = makePhases(unit, this.prompts, baseSha, this.config.maxReviewCycles);
      await pipelineRunner(unit, phases, ctx);
      await ctx.state.advance({ kind: "sliceDone", sliceNumber: unit.sliceNumber });
    };

    switch (this.config.executionMode) {
      case "direct": {
        const firstSliceNumber = groups[0]?.slices[0]?.number ?? 1;
        await executeUnit(directUnit(this.config.planContent, firstSliceNumber));
        break;
      }
      case "grouped": {
        for (const group of groups) {
          await executeUnit(groupedUnit(group));
          if (interrupts.quitRequested()) {
            break;
          }
        }
        break;
      }
      case "sliced": {
        for (const group of groups) {
          for (const slice of group.slices) {
            await ctx.state.advance({
              kind: "sliceStarted",
              sliceNumber: slice.number,
              groupName: group.name,
            });
            await executeUnit(sliceUnit(slice, group.name));
            if (interrupts.quitRequested()) {
              break;
            }
            if (interrupts.skipRequested()) {
              this.sliceSkipFlag = false;
              throw new IncompleteRunError(`Skipped ${group.name} slice ${slice.number}`);
            }
          }
          if (interrupts.quitRequested()) {
            break;
          }
        }
        break;
      }
    }

    this.state = ctx.state.get();
    this.hardInterruptPending = interrupts.hardInterrupt();
  }
}
