import { isRespawnableRole } from "#application/agent-pool.js";
import type { ExecutionUnit } from "#application/execution-unit.js";
import type { PipelineContext } from "#application/pipeline-context.js";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
import { withRetry } from "#application/with-retry.js";
import { IncompleteRunError } from "#domain/errors.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import type { PhaseHandler } from "./phase-handler.js";

export type EvaluateAndFixInput = {
  readonly evaluatorResult: AgentResult;
  readonly fixPromptBuilder: NonNullable<PhaseHandler["fixPrompt"]>;
  readonly isClean: PhaseHandler["isClean"];
  readonly maxCycles: number;
  readonly unit: ExecutionUnit;
  readonly ctx: PipelineContext;
  readonly phase: PhaseHandler;
};

const sendWithRetry = async (
  role: AgentRole,
  prompt: string,
  label: string,
  ctx: PipelineContext,
  streamer?: (text: string) => void,
): Promise<AgentResult> => {
  const agent = await ctx.pool.ensure(role);
  const send = isRespawnableRole(role)
    ? async (): Promise<AgentResult> => {
        const currentAgent = await ctx.pool.ensure(role);
        return currentAgent.send(prompt, streamer);
      }
    : async (): Promise<AgentResult> => agent.send(prompt, streamer);

  return withRetry(send, agent, role, label, {
    pool: ctx.pool,
    interrupts: ctx.interrupts,
    gate: ctx.gate,
    progress: ctx.progress,
    log: ctx.log,
    persistence: ctx.persistence,
    config: ctx.config,
    stateAccessor: ctx.state,
  });
};

const commitSweep = async (unit: ExecutionUnit, ctx: PipelineContext): Promise<void> => {
  if (!(await ctx.git.hasDirtyTree())) {
    return;
  }

  await sendWithRetry("tdd", ctx.prompts.commitSweep(unit.label), `commit sweep ${unit.label}`, ctx);
};

export const evaluateAndFix = async (input: EvaluateAndFixInput): Promise<void> => {
  let findings = input.evaluatorResult.assistantText;

  for (let cycle = 0; cycle < input.maxCycles; cycle++) {
    if (input.ctx.interrupts.skipRequested()) {
      return;
    }

    const fixPrompt = input.fixPromptBuilder(input.unit, findings, input.ctx);
    const preFixSha = await input.ctx.git.captureRef();

    await sendWithRetry("tdd", fixPrompt, `${input.phase.name} fix`, input.ctx);

    if (input.ctx.interrupts.skipRequested()) {
      return;
    }

    const changed = await input.ctx.git.hasChanges(preFixSha);
    if (!changed) {
      break;
    }

    await commitSweep(input.unit, input.ctx);

    if (input.ctx.interrupts.skipRequested()) {
      return;
    }

    const reevaluatePrompt = input.phase.prompt(input.unit, input.ctx);
    const reevaluated = await sendWithRetry(
      input.phase.agent,
      reevaluatePrompt,
      input.phase.name,
      input.ctx,
      input.ctx.progress.createStreamer(input.phase.agent),
    );

    if (input.isClean(reevaluated)) {
      return;
    }

    findings = reevaluated.assistantText;
  }

  throw new IncompleteRunError(
    `Unable to clean ${input.phase.name} findings for ${input.unit.label} after ${input.maxCycles} cycle(s)`,
  );
};
