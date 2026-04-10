import type { ExecutionUnit } from "#application/execution-unit.js";
import type { PipelineContext } from "#application/pipeline-context.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import type { PersistedPhase } from "#domain/state.js";

export type PhaseEvaluate = (
  unit: ExecutionUnit,
  result: AgentResult,
  ctx: PipelineContext,
  phase: PhaseHandler,
) => Promise<void>;

export type PhaseHandler = {
  readonly name: string;
  readonly persistedPhase: PersistedPhase;
  readonly agent: AgentRole;
  readonly prompt: (unit: ExecutionUnit, ctx: PipelineContext) => string;
  readonly isClean: (result: AgentResult, unit?: ExecutionUnit) => boolean;
  readonly fixPrompt?: (unit: ExecutionUnit, findings: string, ctx: PipelineContext) => string;
  readonly evaluate?: PhaseEvaluate;
  readonly maxCycles?: number;
};
