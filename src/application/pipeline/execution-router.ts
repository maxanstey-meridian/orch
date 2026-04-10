import { isRespawnableRole } from "#application/agent-pool.js";
import { directUnit, groupedUnit, sliceUnit, type ExecutionUnit } from "#application/execution-unit.js";
import type { PipelineContext } from "#application/pipeline-context.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import { IncompleteRunError } from "#domain/errors.js";
import type { Group } from "#domain/plan.js";
import type { PersistedPhase } from "#domain/state.js";
import {
  shouldDeferPass,
  shouldRunPass,
  type BoundaryTriageResult,
  type ComplexityTier,
  type PassDecision,
} from "#domain/triage.js";
import { withRetry } from "#application/with-retry.js";
import {
  completenessPhase,
  finalPhases,
  gapPhase,
  planPhase,
  reviewPhase,
  verifyPhase,
} from "./phase-handlers.js";
import type { PhaseHandler } from "./phase-handler.js";
import { pipelineRunner } from "./pipeline-runner.js";

type BoundaryPassName = "completeness" | "verify" | "review" | "gap";

type BoundaryPolicyOptions = {
  readonly unit: ExecutionUnit;
  readonly reviewBaseSha: string;
  readonly activeTier: ComplexityTier;
  readonly finalBoundary: boolean;
  readonly moreUnitsInGroup: boolean;
  readonly resumeFrom?: BoundaryPassName;
};

type PersistedPendingShas = {
  readonly verify?: string;
  readonly completeness?: string;
  readonly review?: string;
  readonly gap?: string;
};

const BOUNDARY_PASSES = ["completeness", "verify", "review", "gap"] as const satisfies readonly BoundaryPassName[];
type SliceResumePhase = Exclude<PersistedPhase, "final">;

const boundaryPhaseFor = (pass: BoundaryPassName): PhaseHandler => {
  switch (pass) {
    case "completeness":
      return completenessPhase;
    case "verify":
      return verifyPhase;
    case "review":
      return reviewPhase;
    case "gap":
      return gapPhase;
  }
};

const boundaryPassIndex = (pass: BoundaryPassName): number => BOUNDARY_PASSES.indexOf(pass);

const isBoundaryPassName = (phase: PersistedPhase): phase is BoundaryPassName =>
  BOUNDARY_PASSES.includes(phase as BoundaryPassName);

const isPassAtOrAfter = (pass: BoundaryPassName, resumeFrom?: BoundaryPassName): boolean =>
  resumeFrom === undefined || boundaryPassIndex(pass) >= boundaryPassIndex(resumeFrom);

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

const runPhase = async (
  unit: ExecutionUnit,
  phase: PhaseHandler,
  ctx: PipelineContext,
): Promise<AgentResult> => {
  ctx.progress.logBadge(phase.agent, phase.name);
  ctx.progress.setActivity(phase.name);

  const result = await sendWithRetry(
    phase.agent,
    phase.prompt(unit, ctx),
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

  let followUpResult = result;
  while (followUpResult.needsInput) {
    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      return followUpResult;
    }

    const prompt =
      followUpResult.assistantText.trim()
      || followUpResult.resultText.trim()
      || `${phase.name} requires operator input for ${unit.label}`;
    const answer = await ctx.gate.askUser(prompt);

    followUpResult = await sendWithRetry(
      phase.agent,
      answer,
      `${phase.name} follow-up`,
      ctx,
      ctx.progress.createStreamer(phase.agent),
    );
    ctx.log.write(phase.agent, followUpResult.assistantText);
  }

  return followUpResult;
};

const commitSweep = async (label: string, ctx: PipelineContext): Promise<void> => {
  if (!(await ctx.git.hasDirtyTree())) {
    return;
  }

  await sendWithRetry("tdd", ctx.prompts.commitSweep(label), `commit sweep ${label}`, ctx);
};

const currentPendingShas = (ctx: PipelineContext): PersistedPendingShas => {
  const state = ctx.state.get();
  return {
    verify: state.pendingVerifyBaseSha,
    completeness: state.pendingCompletenessBaseSha,
    review: state.pendingReviewBaseSha,
    gap: state.pendingGapBaseSha,
  };
};

const currentPendingFlags = (ctx: PipelineContext) => {
  const pending = currentPendingShas(ctx);
  return {
    verify: pending.verify !== undefined,
    completeness: pending.completeness !== undefined,
    review: pending.review !== undefined,
    gap: pending.gap !== undefined,
  };
};

const isPassEnabled = (pass: BoundaryPassName, ctx: PipelineContext): boolean => {
  switch (pass) {
    case "completeness":
      return ctx.config.skills.completeness !== null;
    case "verify":
      return ctx.config.skills.verify !== null;
    case "review":
      return ctx.config.skills.review !== null;
    case "gap":
      return ctx.config.skills.gap !== null;
  }
};

const normalizeDecision = (
  pass: BoundaryPassName,
  decision: PassDecision,
  ctx: PipelineContext,
): PassDecision => isPassEnabled(pass, ctx) ? decision : "skip";

const updatePolicyState = async (
  activeTier: ComplexityTier,
  currentGroupBaseSha: string | undefined,
  pending: PersistedPendingShas,
  ctx: PipelineContext,
): Promise<void> => {
  await ctx.state.advance({
    kind: "policyUpdated",
    activeTier,
    currentGroupBaseSha,
    pendingVerifyBaseSha: pending.verify,
    pendingCompletenessBaseSha: pending.completeness,
    pendingReviewBaseSha: pending.review,
    pendingGapBaseSha: pending.gap,
  });
};

const prepareTier = async (
  unit: ExecutionUnit,
  currentGroupBaseSha: string | undefined,
  ctx: PipelineContext,
  resume = false,
): Promise<ComplexityTier> => {
  if (resume) {
    return ctx.state.get().activeTier ?? ctx.config.tier;
  }

  const selected = await ctx.tierSelector.select({
    mode: ctx.config.executionMode,
    unitKind: unit.kind,
    content: unit.content,
  });

  await updatePolicyState(selected.tier, currentGroupBaseSha, currentPendingShas(ctx), ctx);
  return selected.tier;
};

const isGroupCompleted = (group: Group, ctx: PipelineContext): boolean => {
  const state = ctx.state.get();
  const lastSliceNumber = group.slices[group.slices.length - 1]?.number ?? 0;

  return state.lastCompletedGroup === group.name
    && (state.lastCompletedSlice ?? 0) >= lastSliceNumber;
};

const resumedSlicePhase = (unit: ExecutionUnit, ctx: PipelineContext): SliceResumePhase | null => {
  if (unit.kind !== "slice") {
    return null;
  }

  const state = ctx.state.get();
  if (state.currentGroup !== unit.groupName || state.currentSlice !== unit.sliceNumber) {
    return null;
  }

  if (state.currentPhase === undefined || state.currentPhase === "final") {
    return null;
  }

  return state.currentPhase;
};

const runDirectExecution = async (
  unit: ExecutionUnit,
  ctx: PipelineContext,
): Promise<void> => {
  await runPhase(
    unit,
    {
      name: "execute",
      persistedPhase: "tdd",
      agent: "tdd",
      prompt: (currentUnit, currentCtx) => currentCtx.prompts.directExecute(currentUnit.content),
      isClean: () => true,
    },
    ctx,
  );

  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return;
  }

  await runPhase(
    unit,
    {
      name: "test pass",
      persistedPhase: "tdd",
      agent: "tdd",
      prompt: (currentUnit, currentCtx) => currentCtx.prompts.directTestPass(currentUnit.content),
      isClean: () => true,
    },
    ctx,
  );
};

const runGroupedExecution = async (
  unit: ExecutionUnit,
  ctx: PipelineContext,
): Promise<void> => {
  const firstGroup = ctx.state.get().lastCompletedGroup === undefined;

  await runPhase(
    unit,
    {
      name: "execute",
      persistedPhase: "tdd",
      agent: "tdd",
      prompt: (currentUnit, currentCtx) =>
        currentCtx.prompts.groupedExecute(currentUnit.groupName, currentUnit.content, firstGroup),
      isClean: () => true,
    },
    ctx,
  );

  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return;
  }

  await runPhase(
    unit,
    {
      name: "test pass",
      persistedPhase: "tdd",
      agent: "tdd",
      prompt: (currentUnit, currentCtx) =>
        currentCtx.prompts.groupedTestPass(currentUnit.groupName, currentUnit.content),
      isClean: () => true,
    },
    ctx,
  );
};

const runSliceExecutionWithoutPlan = async (
  unit: ExecutionUnit,
  ctx: PipelineContext,
): Promise<void> => {
  await runPhase(
    unit,
    {
      name: "execute",
      persistedPhase: "tdd",
      agent: "tdd",
      prompt: (currentUnit, currentCtx) =>
        currentCtx.prompts.tdd(currentUnit.content, undefined, currentUnit.sliceNumber),
      isClean: () => true,
    },
    ctx,
  );
};

const runPlannedSliceExecution = async (
  unit: ExecutionUnit,
  ctx: PipelineContext,
  forceAccept = false,
): Promise<void> => {
  let operatorGuidance: string | undefined;
  let acceptedPlanText: string | null = null;

  for (let attempt = 0; attempt <= ctx.config.maxReplans; attempt++) {
    if (acceptedPlanText === null) {
      const planResult = await runPhase(unit, planPhase, ctx);
      if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
        return;
      }

      acceptedPlanText = planResult.planText ?? planResult.assistantText;
      const interruptGuidance = ctx.interrupts.hardInterrupt();
      if (interruptGuidance !== null) {
        operatorGuidance = interruptGuidance;
        ctx.interrupts.clearHardInterrupt();
      }

      if (!forceAccept && !ctx.config.auto) {
        const decision = await ctx.gate.confirmPlan(acceptedPlanText);
        if (decision.kind === "reject") {
          acceptedPlanText = null;
          if (attempt === ctx.config.maxReplans) {
            throw new IncompleteRunError(`Plan rejected too many times for ${unit.label}`);
          }
          continue;
        }
        if (decision.kind === "edit") {
          operatorGuidance = decision.guidance;
        }
      }
    }

    const firstSlice = ctx.state.get().lastSliceImplemented === undefined;
    await runPhase(
      unit,
      {
        name: "execute",
        persistedPhase: "tdd",
        agent: "tdd",
        prompt: (currentUnit, currentCtx) =>
          currentCtx.prompts.tddExecute(
            acceptedPlanText ?? currentUnit.content,
            currentUnit.sliceNumber,
            firstSlice,
            operatorGuidance,
          ),
        isClean: () => true,
      },
      ctx,
    );

    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      return;
    }

    const interruptGuidance = ctx.interrupts.hardInterrupt();
    if (interruptGuidance === null) {
      return;
    }

    ctx.interrupts.clearHardInterrupt();
    operatorGuidance = interruptGuidance;
    await ctx.pool.respawn("tdd");
  }

  throw new IncompleteRunError(`Max replans exceeded for ${unit.label}`);
};

const planThenExecute = async (
  unit: ExecutionUnit,
  ctx: PipelineContext,
  forceAccept = false,
  resumePhase: "plan" | "tdd" | null = null,
): Promise<void> => {
  switch (unit.kind) {
    case "direct":
      await runDirectExecution(unit, ctx);
      return;
    case "group":
      await runGroupedExecution(unit, ctx);
      return;
    case "slice":
      if (resumePhase === "tdd" || ctx.config.skills.plan === null) {
        await runSliceExecutionWithoutPlan(unit, ctx);
        return;
      }
      await runPlannedSliceExecution(unit, ctx, forceAccept);
  }
};

const runNowPhases = (
  decisions: BoundaryTriageResult,
  ctx: PipelineContext,
  resumeFrom?: BoundaryPassName,
): readonly PhaseHandler[] => BOUNDARY_PASSES
  .filter((pass) => isPassAtOrAfter(pass, resumeFrom))
  .filter((pass) => pass === resumeFrom || shouldRunPass(decisions[pass]))
  .filter((pass) => isPassEnabled(pass, ctx))
  .map(boundaryPhaseFor);

const deferredShaForPass = (
  pass: BoundaryPassName,
  decision: PassDecision,
  baseSha: string,
  previous: PersistedPendingShas,
  resumeFrom?: BoundaryPassName,
): string | undefined => {
  if (!isPassAtOrAfter(pass, resumeFrom)) {
    return previous[pass];
  }

  if (pass === resumeFrom) {
    return undefined;
  }

  return shouldDeferPass(decision) ? baseSha : previous[pass];
};

const deferredShasFor = (
  decisions: BoundaryTriageResult,
  baseSha: string,
  previous: PersistedPendingShas,
  resumeFrom?: BoundaryPassName,
): PersistedPendingShas => ({
  verify: deferredShaForPass("verify", decisions.verify, baseSha, previous, resumeFrom),
  completeness: deferredShaForPass(
    "completeness",
    decisions.completeness,
    baseSha,
    previous,
    resumeFrom,
  ),
  review: deferredShaForPass("review", decisions.review, baseSha, previous, resumeFrom),
  gap: deferredShaForPass("gap", decisions.gap, baseSha, previous, resumeFrom),
});

const deferredBaseForSliceImplemented = (
  pass: Exclude<BoundaryPassName, "review">,
  decision: PassDecision,
  baseSha: string,
  resumeFrom?: BoundaryPassName,
): string | undefined => {
  if (!isPassAtOrAfter(pass, resumeFrom) || pass === resumeFrom) {
    return undefined;
  }

  return shouldDeferPass(decision) ? baseSha : undefined;
};

const applyBoundaryPolicy = async (
  options: BoundaryPolicyOptions,
  ctx: PipelineContext,
): Promise<BoundaryTriageResult> => {
  const diff = await ctx.git.getDiff(options.reviewBaseSha);
  const diffStats = await ctx.git.measureDiff(options.reviewBaseSha);
  const previousPending = currentPendingShas(ctx);
  const rawDecision = await ctx.triager.decide({
    mode: ctx.config.executionMode,
    unitKind: options.unit.kind,
    diff,
    diffStats,
    reviewThreshold: ctx.config.reviewThreshold,
    finalBoundary: options.finalBoundary,
    moreUnitsInGroup: options.moreUnitsInGroup,
    pending: currentPendingFlags(ctx),
  });

  const decisions: BoundaryTriageResult = {
    completeness: normalizeDecision("completeness", rawDecision.completeness, ctx),
    verify: normalizeDecision("verify", rawDecision.verify, ctx),
    review: normalizeDecision("review", rawDecision.review, ctx),
    gap: normalizeDecision("gap", rawDecision.gap, ctx),
    reason: rawDecision.reason,
  };

  await ctx.state.advance({
    kind: "sliceImplemented",
    sliceNumber: options.unit.sliceNumber,
    reviewBaseSha: options.reviewBaseSha,
    pendingVerifyBaseSha: deferredBaseForSliceImplemented(
      "verify",
      decisions.verify,
      options.reviewBaseSha,
      options.resumeFrom,
    ),
    pendingCompletenessBaseSha: deferredBaseForSliceImplemented(
      "completeness",
      decisions.completeness,
      options.reviewBaseSha,
      options.resumeFrom,
    ),
    pendingGapBaseSha: deferredBaseForSliceImplemented(
      "gap",
      decisions.gap,
      options.reviewBaseSha,
      options.resumeFrom,
    ),
  });

  await updatePolicyState(
    options.activeTier,
    ctx.state.get().currentGroupBaseSha,
    deferredShasFor(decisions, options.reviewBaseSha, previousPending, options.resumeFrom),
    ctx,
  );

  const phases = runNowPhases(decisions, ctx, options.resumeFrom);
  if (phases.length > 0) {
    await pipelineRunner(options.unit, phases, ctx);
  }

  return decisions;
};

const runDeferredPhase = async (
  pass: BoundaryPassName,
  baseSha: string,
  group: Group,
  ctx: PipelineContext,
): Promise<void> => {
  const pendingBefore = currentPendingShas(ctx);
  const nextState = {
    ...ctx.state.get(),
    reviewBaseSha: pass === "review" ? baseSha : undefined,
    pendingVerifyBaseSha: pass === "verify" ? baseSha : undefined,
    pendingCompletenessBaseSha: pass === "completeness" ? baseSha : undefined,
    pendingReviewBaseSha: pass === "review" ? baseSha : undefined,
    pendingGapBaseSha: pass === "gap" ? baseSha : undefined,
  };
  ctx.state.set(nextState);

  await pipelineRunner(groupedUnit(group), [boundaryPhaseFor(pass)], ctx);

  const clearedPending: PersistedPendingShas = {
    verify: pass === "verify" ? undefined : pendingBefore.verify,
    completeness: pass === "completeness" ? undefined : pendingBefore.completeness,
    review: pass === "review" ? undefined : pendingBefore.review,
    gap: pass === "gap" ? undefined : pendingBefore.gap,
  };

  await updatePolicyState(
    ctx.state.get().activeTier ?? ctx.config.tier,
    ctx.state.get().currentGroupBaseSha,
    clearedPending,
    ctx,
  );
};

const flushDeferredGroupPasses = async (
  group: Group,
  ctx: PipelineContext,
): Promise<void> => {
  const pending = currentPendingShas(ctx);

  for (const pass of BOUNDARY_PASSES) {
    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      return;
    }

    const baseSha = pending[pass];
    if (baseSha === undefined) {
      continue;
    }

    if (!(await ctx.git.hasChanges(baseSha))) {
      continue;
    }

    await runDeferredPhase(pass, baseSha, group, ctx);
  }
};

const runFinalPasses = async (
  unit: ExecutionUnit,
  ctx: PipelineContext,
): Promise<void> => {
  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return;
  }

  const baseSha = await ctx.git.captureRef();
  const phases = finalPhases(baseSha, ctx, unit);
  if (phases.length === 0) {
    return;
  }

  await pipelineRunner(unit, phases, ctx);
};

const runSlicedGroup = async (
  group: Group,
  groupIndex: number,
  groups: readonly Group[],
  ctx: PipelineContext,
): Promise<ExecutionUnit | null> => {
  if (isGroupCompleted(group, ctx)) {
    return null;
  }

  const resumeGroup = ctx.state.get().currentGroup === group.name && ctx.state.get().currentPhase !== undefined;
  const firstSliceNumber = group.slices[0]?.number ?? 0;
  await ctx.state.advance({
    kind: "groupStarted",
    groupName: group.name,
    sliceNumber: resumeGroup ? (ctx.state.get().currentSlice ?? firstSliceNumber) : firstSliceNumber,
  });

  const groupBaseSha = await ctx.git.captureRef();
  await updatePolicyState(ctx.state.get().activeTier ?? ctx.config.tier, groupBaseSha, currentPendingShas(ctx), ctx);

  let lastUnit: ExecutionUnit | null = null;

  for (const slice of group.slices) {
    if ((ctx.state.get().lastCompletedSlice ?? 0) >= slice.number) {
      continue;
    }

    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      break;
    }

    const unit = sliceUnit(slice, group.name);
    const resumePhase = resumedSlicePhase(unit, ctx);
    const resume = resumePhase !== null;
    if (!resume) {
      ctx.progress.logSliceIntro(slice);
    }

    await prepareTier(unit, groupBaseSha, ctx, resume);
    if (!resume) {
      await ctx.state.advance({ kind: "sliceStarted", sliceNumber: slice.number, groupName: group.name });
    }

    const reviewBaseSha = ctx.state.get().reviewBaseSha ?? (await ctx.git.captureRef());
    const moreUnitsInGroup = group.slices.some((candidate) => candidate.number > slice.number);

    if (resumePhase !== null && isBoundaryPassName(resumePhase)) {
      await applyBoundaryPolicy(
        {
          unit,
          reviewBaseSha,
          activeTier: ctx.state.get().activeTier ?? ctx.config.tier,
          finalBoundary: false,
          moreUnitsInGroup,
          resumeFrom: resumePhase,
        },
        ctx,
      );
    } else {
      await planThenExecute(unit, ctx, false, resumePhase === "tdd" || resumePhase === "plan" ? resumePhase : null);

      if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
        break;
      }

      await commitSweep(unit.label, ctx);

      if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
        break;
      }

      await applyBoundaryPolicy(
        {
          unit,
          reviewBaseSha,
          activeTier: ctx.state.get().activeTier ?? ctx.config.tier,
          finalBoundary: false,
          moreUnitsInGroup,
        },
        ctx,
      );
    }

    if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
      break;
    }

    await ctx.state.advance({ kind: "sliceDone", sliceNumber: slice.number });
    lastUnit = unit;
  }

  if (!ctx.interrupts.skipRequested() && !ctx.interrupts.quitRequested()) {
    await flushDeferredGroupPasses(group, ctx);
    await commitSweep(`Group ${group.name}`, ctx);
    await ctx.state.advance({ kind: "groupDone", groupName: group.name });
  }

  await ctx.pool.killGroupScoped();
  await updatePolicyState(ctx.state.get().activeTier ?? ctx.config.tier, undefined, {}, ctx);

  if (
    !ctx.interrupts.skipRequested()
    && !ctx.interrupts.quitRequested()
    && groupIndex < groups.length - 1
  ) {
    await ctx.pool.respawnAll();
    if (!ctx.config.auto) {
      const shouldContinue = await ctx.gate.confirmNextGroup(group.name);
      if (!shouldContinue) {
        ctx.interrupts.requestQuit();
      }
    }
  }

  return lastUnit;
};

const runGroupedGroup = async (
  group: Group,
  groupIndex: number,
  groups: readonly Group[],
  ctx: PipelineContext,
): Promise<ExecutionUnit | null> => {
  if (isGroupCompleted(group, ctx)) {
    return null;
  }

  const unit = groupedUnit(group);
  const firstSliceNumber = group.slices[0]?.number ?? unit.sliceNumber;
  await ctx.state.advance({ kind: "groupStarted", groupName: group.name, sliceNumber: firstSliceNumber });

  const groupBaseSha = await ctx.git.captureRef();
  const activeTier = await prepareTier(unit, groupBaseSha, ctx);

  await planThenExecute(unit, ctx);
  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return null;
  }

  await commitSweep(unit.label, ctx);
  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return null;
  }

  await applyBoundaryPolicy(
    {
      unit,
      reviewBaseSha: groupBaseSha,
      activeTier,
      finalBoundary: true,
      moreUnitsInGroup: false,
    },
    ctx,
  );

  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return null;
  }

  await ctx.state.advance({ kind: "sliceDone", sliceNumber: unit.sliceNumber });
  await commitSweep(unit.label, ctx);
  await ctx.state.advance({ kind: "groupDone", groupName: group.name });
  await ctx.pool.killGroupScoped();
  await updatePolicyState(ctx.state.get().activeTier ?? ctx.config.tier, undefined, {}, ctx);

  if (groupIndex < groups.length - 1) {
    await ctx.pool.respawnAll();
    if (!ctx.config.auto) {
      const shouldContinue = await ctx.gate.confirmNextGroup(group.name);
      if (!shouldContinue) {
        ctx.interrupts.requestQuit();
      }
    }
  }

  return unit;
};

const runDirectMode = async (
  groups: readonly Group[],
  ctx: PipelineContext,
): Promise<ExecutionUnit | null> => {
  if (groups.length === 0) {
    return null;
  }

  const representativeSliceNumber = groups[0]?.slices[0]?.number ?? 1;
  const unit = directUnit(ctx.config.planContent, representativeSliceNumber);
  const activeTier = await prepareTier(unit, undefined, ctx);
  const reviewBaseSha = await ctx.git.captureRef();

  await planThenExecute(unit, ctx);
  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return null;
  }

  await commitSweep(unit.label, ctx);
  if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
    return null;
  }

  await applyBoundaryPolicy(
    {
      unit,
      reviewBaseSha,
      activeTier,
      finalBoundary: true,
      moreUnitsInGroup: false,
    },
    ctx,
  );

  return unit;
};

export const executeGroups = async (
  groups: readonly Group[],
  ctx: PipelineContext,
): Promise<void> => {
  ctx.progress.logExecutionMode(ctx.config.executionMode);
  ctx.progress.updateProgress({
    totalSlices: groups.reduce((sum, group) => sum + group.slices.length, 0),
    completedSlices: ctx.state.get().lastCompletedSlice ?? 0,
    startTime: Date.now(),
  });

  let lastUnit: ExecutionUnit | null = null;

  switch (ctx.config.executionMode) {
    case "direct":
      lastUnit = await runDirectMode(groups, ctx);
      break;
    case "grouped":
      for (const [index, group] of groups.entries()) {
        lastUnit = await runGroupedGroup(group, index, groups, ctx) ?? lastUnit;
        if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
          break;
        }
      }
      break;
    case "sliced":
      for (const [index, group] of groups.entries()) {
        lastUnit = await runSlicedGroup(group, index, groups, ctx) ?? lastUnit;
        if (ctx.interrupts.skipRequested() || ctx.interrupts.quitRequested()) {
          break;
        }
      }
      break;
  }

  await runFinalPasses(lastUnit ?? directUnit(ctx.config.planContent, groups[0]?.slices[0]?.number ?? 1), ctx);
};
