import { isRespawnableRole } from "#application/agent-pool.js";
import type { ExecutionUnit } from "#application/execution-unit.js";
import type { PipelineContext } from "#application/pipeline-context.js";
import { withRetry } from "#application/with-retry.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import { evaluateAndFix } from "./evaluate-and-fix.js";
import type { PhaseHandler } from "./phase-handler.js";

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
    delayMs: ctx.retryDelayMs,
    minDurationMs: ctx.minAgentDurationMs,
    usageProbeDelayMs: ctx.usageProbeDelayMs,
    usageProbeMaxDelayMs: ctx.usageProbeMaxDelayMs,
  });
};

export const pipelineRunner = async (
  unit: ExecutionUnit,
  phases: readonly PhaseHandler[],
  ctx: PipelineContext,
): Promise<void> => {
  for (const phase of phases) {
    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      break;
    }

    ctx.progress.logBadge(phase.agent, phase.name);
    ctx.progress.setActivity(phase.name);

    const prompt = phase.prompt(unit, ctx);
    const result = await sendWithRetry(
      phase.agent,
      prompt,
      phase.name,
      ctx,
      ctx.progress.createStreamer(phase.agent),
    );

    await ctx.state.advance({
      kind: "phaseEntered",
      phase: phase.persistedPhase,
      sliceNumber: unit.sliceNumber,
    });
    ctx.log.write(phase.agent, result.assistantText);

    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      break;
    }

    if (!phase.isClean(result) && phase.fixPrompt) {
      await evaluateAndFix({
        evaluatorResult: result,
        fixPromptBuilder: phase.fixPrompt,
        isClean: phase.isClean,
        maxCycles: phase.maxCycles ?? ctx.config.maxReviewCycles,
        unit,
        ctx,
        phase,
      });
    }
  }
};

export const runPipeline = pipelineRunner;
