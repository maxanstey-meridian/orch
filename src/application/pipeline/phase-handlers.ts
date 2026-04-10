import { isRespawnableRole } from "#application/agent-pool.js";
import type { ExecutionUnit } from "#application/execution-unit.js";
import type { PipelineContext } from "#application/pipeline-context.js";
import { withRetry } from "#application/with-retry.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import { IncompleteRunError } from "#domain/errors.js";
import { isCleanReview } from "#domain/review-check.js";
import { isVerifyPassing, parseVerifyResult } from "#domain/verify.js";
import type { PhaseEvaluate, PhaseHandler } from "./phase-handler.js";

const DEFAULT_BASE_SHA = "HEAD";

const resolveVerifyBaseSha = (ctx: PipelineContext): string => {
  const state = ctx.state.get();
  return state.pendingVerifyBaseSha
    ?? state.reviewBaseSha
    ?? state.currentGroupBaseSha
    ?? DEFAULT_BASE_SHA;
};

const resolveCompletenessBaseSha = (ctx: PipelineContext): string => {
  const state = ctx.state.get();
  return state.pendingCompletenessBaseSha
    ?? state.reviewBaseSha
    ?? state.currentGroupBaseSha
    ?? DEFAULT_BASE_SHA;
};

const resolveReviewBaseSha = (ctx: PipelineContext): string => {
  const state = ctx.state.get();
  return state.pendingReviewBaseSha
    ?? state.reviewBaseSha
    ?? state.currentGroupBaseSha
    ?? DEFAULT_BASE_SHA;
};

const resolveGapBaseSha = (ctx: PipelineContext): string => {
  const state = ctx.state.get();
  return state.pendingGapBaseSha
    ?? state.reviewBaseSha
    ?? state.currentGroupBaseSha
    ?? DEFAULT_BASE_SHA;
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
    delayMs: ctx.retryDelayMs,
    minDurationMs: ctx.minAgentDurationMs,
    usageProbeDelayMs: ctx.usageProbeDelayMs,
    usageProbeMaxDelayMs: ctx.usageProbeMaxDelayMs,
  });
};

const commitSweep = async (unit: ExecutionUnit, ctx: PipelineContext): Promise<void> => {
  if (!(await ctx.git.hasDirtyTree())) {
    return;
  }

  await sendWithRetry("tdd", ctx.prompts.commitSweep(unit.label), `commit sweep ${unit.label}`, ctx);
};

const buildTddFixPrompt = (unit: ExecutionUnit, findings: string, ctx: PipelineContext): string =>
  ctx.prompts.tdd(unit.content, findings, unit.sliceNumber);

const buildVerifyFixFindings = (findings: string): string => {
  const parsed = parseVerifyResult(findings);
  if (parsed.sliceLocalFailures.length > 0) {
    return parsed.sliceLocalFailures.join("\n");
  }
  return parsed.summary;
};

const buildVerifyPrompt = (
  unit: ExecutionUnit,
  ctx: PipelineContext,
  fixSummary?: string,
): string => {
  const baseSha = resolveVerifyBaseSha(ctx);

  switch (unit.kind) {
    case "direct":
      return ctx.prompts.directVerify(baseSha, unit.content, fixSummary);
    case "group":
      return ctx.prompts.groupedVerify(baseSha, unit.groupName, fixSummary);
    case "slice":
      return ctx.prompts.verify(baseSha, unit.sliceNumber, fixSummary);
  }
};

const buildReviewPrompt = (unit: ExecutionUnit, ctx: PipelineContext): string => {
  const baseSha = resolveReviewBaseSha(ctx);

  switch (unit.kind) {
    case "direct":
      return ctx.prompts.directReview(unit.content, baseSha);
    case "group":
    case "slice":
      return ctx.prompts.review(unit.content, baseSha);
  }
};

const buildCompletenessPrompt = (unit: ExecutionUnit, ctx: PipelineContext): string => {
  const baseSha = resolveCompletenessBaseSha(ctx);

  switch (unit.kind) {
    case "direct":
      return ctx.prompts.directCompleteness(unit.content, baseSha);
    case "group":
      return ctx.prompts.groupedCompleteness(unit.content, baseSha, unit.groupName);
    case "slice":
      return ctx.prompts.completeness(unit.content, baseSha, unit.sliceNumber);
  }
};

const buildGapPrompt = (unit: ExecutionUnit, ctx: PipelineContext): string => {
  if (unit.kind === "direct") {
    return ctx.prompts.directGap(unit.content);
  }

  return ctx.prompts.withBrief(ctx.prompts.gap(unit.content, resolveGapBaseSha(ctx)));
};

const unsupportedUnit = (phaseName: string, unit: ExecutionUnit): never => {
  throw new Error(`${phaseName} phase does not support ${unit.kind} units`);
};

const verifyEvaluate: PhaseEvaluate = async (unit, result, ctx, phase) => {
  const maxCycles = Math.min(phase.maxCycles ?? ctx.config.maxReviewCycles, ctx.config.maxReviewCycles);
  let findings = result.assistantText;
  let parsed = parseVerifyResult(findings);

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      return;
    }

    const builderFixable = parsed.retryable && parsed.sliceLocalFailures.length > 0;
    if (!builderFixable) {
      if (ctx.config.auto) {
        throw new IncompleteRunError(`Verify failed for ${unit.label}: ${parsed.summary}`);
      }

      const decision = await ctx.gate.verifyFailed(unit.label, parsed.summary, parsed.retryable);
      if (decision.kind === "skip") {
        return;
      }
      if (decision.kind === "stop") {
        throw new IncompleteRunError(`Verify failed for ${unit.label}: ${parsed.summary}`);
      }

      const retried = await sendWithRetry(
        "verify",
        buildVerifyPrompt(unit, ctx),
        `${phase.name} retry`,
        ctx,
        ctx.progress.createStreamer("verify"),
      );

      if (phase.isClean(retried, unit)) {
        return;
      }

      findings = retried.assistantText;
      parsed = parseVerifyResult(findings);
      continue;
    }

    const fixPrompt = phase.fixPrompt?.(unit, findings, ctx);
    if (!fixPrompt) {
      throw new IncompleteRunError(`Verify phase has no fix prompt for ${unit.label}`);
    }

    const preFixSha = await ctx.git.captureRef();
    await sendWithRetry("tdd", fixPrompt, `${phase.name} fix`, ctx);

    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      return;
    }

    if (!(await ctx.git.hasChanges(preFixSha))) {
      break;
    }

    await commitSweep(unit, ctx);

    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      return;
    }

    const fixSummary = parsed.sliceLocalFailures.join("\n");
    const reverified = await sendWithRetry(
      "verify",
      buildVerifyPrompt(unit, ctx, fixSummary),
      phase.name,
      ctx,
      ctx.progress.createStreamer("verify"),
    );

    if (phase.isClean(reverified, unit)) {
      return;
    }

    findings = reverified.assistantText;
    parsed = parseVerifyResult(findings);
  }

  throw new IncompleteRunError(
    `Unable to clean ${phase.name} findings for ${unit.label} after ${maxCycles} cycle(s)`,
  );
};

export const planPhase = {
  name: "plan",
  persistedPhase: "plan",
  agent: "tdd",
  prompt: (unit, ctx) => {
    if (unit.kind !== "slice") {
      return unsupportedUnit("plan", unit);
    }
    return ctx.prompts.plan(unit.content, unit.sliceNumber);
  },
  isClean: () => true,
} satisfies PhaseHandler;

export const executePhase = {
  name: "execute",
  persistedPhase: "tdd",
  agent: "tdd",
  prompt: (unit, ctx) => {
    switch (unit.kind) {
      case "direct":
        return ctx.prompts.directExecute(unit.content);
      case "group":
        return ctx.prompts.groupedExecute(unit.groupName, unit.content, false);
      case "slice":
        return ctx.prompts.tdd(unit.content, undefined, unit.sliceNumber);
    }
  },
  isClean: () => true,
} satisfies PhaseHandler;

export const completenessPhase = {
  name: "completeness",
  persistedPhase: "completeness",
  agent: "completeness",
  prompt: buildCompletenessPrompt,
  isClean: (result, unit) =>
    result.assistantText.includes(
      unit?.kind === "group"
        ? "GROUP_COMPLETE"
        : unit?.kind === "direct"
          ? "DIRECT_COMPLETE"
          : "SLICE_COMPLETE",
    )
    && !result.assistantText.includes("MISSING")
    && !result.assistantText.includes("❌"),
  fixPrompt: buildTddFixPrompt,
} satisfies PhaseHandler;

export const verifyPhase = {
  name: "verify",
  persistedPhase: "verify",
  agent: "verify",
  prompt: buildVerifyPrompt,
  isClean: (result) => isVerifyPassing(parseVerifyResult(result.assistantText)),
  fixPrompt: (unit, findings, ctx) => buildTddFixPrompt(unit, buildVerifyFixFindings(findings), ctx),
  evaluate: verifyEvaluate,
} satisfies PhaseHandler;

export const reviewPhase = {
  name: "review",
  persistedPhase: "review",
  agent: "review",
  prompt: buildReviewPrompt,
  isClean: (result) => isCleanReview(result.assistantText),
  fixPrompt: buildTddFixPrompt,
} satisfies PhaseHandler;

export const gapPhase = {
  name: "gap",
  persistedPhase: "gap",
  agent: "gap",
  prompt: buildGapPrompt,
  isClean: (result) =>
    result.exitCode === 0 && result.assistantText.includes("NO_GAPS_FOUND"),
  fixPrompt: buildTddFixPrompt,
  maxCycles: 2,
} satisfies PhaseHandler;

export const finalPhases = (
  baseSha: string,
  ctx: PipelineContext,
  unit?: ExecutionUnit,
): readonly PhaseHandler[] => {
  const passes = unit?.kind === "direct"
    ? ctx.prompts.directFinalPasses(baseSha, unit.content)
    : ctx.prompts.finalPasses(baseSha);

  return passes.map((pass) => ({
    name: pass.name,
    persistedPhase: "final" as const,
    agent: "final" as const,
    prompt: () => ctx.prompts.withBrief(pass.prompt),
    isClean: (result) =>
      result.exitCode === 0
      && (result.assistantText.trim() === "" || result.assistantText.includes("NO_ISSUES_FOUND")),
    fixPrompt: buildTddFixPrompt,
  }));
};
