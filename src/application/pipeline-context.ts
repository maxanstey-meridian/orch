import type { AgentPool } from "#application/agent-pool.js";
import type { InterruptState } from "#application/interrupt-state.js";
import type { ExecutionUnitTierSelector } from "#application/ports/execution-unit-tier-selector.port.js";
import type { ExecutionUnitTriager } from "#application/ports/execution-unit-triager.port.js";
import type { GitOps } from "#application/ports/git-ops.port.js";
import type { LogWriter } from "#application/ports/log-writer.port.js";
import type { OperatorGate } from "#application/ports/operator-gate.port.js";
import type { ProgressSink } from "#application/ports/progress-sink.port.js";
import type { PromptBuilder } from "#application/ports/prompt-builder.port.js";
import type { StatePersistence } from "#application/ports/state-persistence.port.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { advanceState, type OrchestratorState, type StateEvent } from "#domain/state.js";

export type StateAccessor = {
  readonly get: () => OrchestratorState;
  readonly set: (state: OrchestratorState) => void;
  readonly advance: (event: StateEvent) => Promise<void>;
};

export type PipelineContext = {
  readonly config: OrchestratorConfig;
  readonly state: StateAccessor;
  readonly git: GitOps;
  readonly persistence: StatePersistence;
  readonly progress: ProgressSink;
  readonly log: LogWriter;
  readonly prompts: PromptBuilder;
  readonly gate: OperatorGate;
  readonly pool: AgentPool;
  readonly interrupts: InterruptState;
  readonly triager: ExecutionUnitTriager;
  readonly tierSelector: ExecutionUnitTierSelector;
};

export type CreatePipelineContextOptions = {
  readonly config: OrchestratorConfig;
  readonly initialState?: OrchestratorState;
  readonly git: GitOps;
  readonly persistence: StatePersistence;
  readonly progress: ProgressSink;
  readonly log: LogWriter;
  readonly prompts: PromptBuilder;
  readonly gate: OperatorGate;
  readonly pool: AgentPool;
  readonly interrupts: InterruptState;
  readonly triager: ExecutionUnitTriager;
  readonly tierSelector: ExecutionUnitTierSelector;
};

export const createPipelineContext = (options: CreatePipelineContextOptions): PipelineContext => {
  let currentState = options.initialState ?? {};

  const state: StateAccessor = {
    get: () => currentState,
    set: (nextState: OrchestratorState) => {
      currentState = nextState;
    },
    advance: async (event: StateEvent) => {
      currentState = advanceState(currentState, event);
      await options.persistence.save(currentState);
    },
  };

  return {
    config: options.config,
    state,
    git: options.git,
    persistence: options.persistence,
    progress: options.progress,
    log: options.log,
    prompts: options.prompts,
    gate: options.gate,
    pool: options.pool,
    interrupts: options.interrupts,
    triager: options.triager,
    tierSelector: options.tierSelector,
  };
};
