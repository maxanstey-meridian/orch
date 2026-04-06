import type { ExecutionUnitTierSelector } from "#application/ports/execution-unit-tier-selector.port.js";
import type {
  ExecutionUnitKind,
  ExecutionUnitTriager,
} from "#application/ports/execution-unit-triager.port.js";
import type { RolePromptResolver } from "#application/ports/role-prompt-resolver.port.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import { detectApiError } from "#domain/api-errors.js";
import type { ApiError } from "#domain/api-errors.js";
import type { OrchestratorConfig, Provider, SkillRole } from "#domain/config.js";
import { CreditExhaustedError, IncompleteRunError } from "#domain/errors.js";
import type { Phase } from "#domain/phase.js";
import type { Group } from "#domain/plan.js";
import type { Slice } from "#domain/plan.js";
import { isCleanReview } from "#domain/review-check.js";
import type {
  OrchestratorState,
  PersistedAgentSession,
  PersistedPhase,
  StateEvent,
} from "#domain/state.js";
import { advanceState } from "#domain/state.js";
import { isAlreadyImplemented } from "#domain/transition.js";
import { transition } from "#domain/transition.js";
import {
  FULL_TRIAGE,
  shouldDeferPass,
  shouldSkipPass,
  type BoundaryTriageResult,
  type ComplexityTier,
  type PassDecision,
} from "#domain/triage.js";
import { isVerifyPassing, parseVerifyResult, type VerifyResult } from "#domain/verify.js";
import type { AgentSpawner, AgentHandle } from "./ports/agent-spawner.port.js";
import type { GitOps } from "./ports/git-ops.port.js";
import type { LogWriter } from "./ports/log-writer.port.js";
import type { OperatorGate } from "./ports/operator-gate.port.js";
import type { ProgressSink } from "./ports/progress-sink.port.js";
import type { FinalPass, PromptBuilder } from "./ports/prompt-builder.port.js";
import type { StatePersistence } from "./ports/state-persistence.port.js";

export type PlanThenExecuteResult = {
  readonly tddResult: AgentResult;
  readonly skipped: boolean;
  readonly hardInterrupt?: string;
  readonly replan?: boolean;
  readonly planText?: string;
};

type ExecutionUnit = {
  readonly kind: "slice" | "group" | "direct";
  readonly label: string;
  readonly content: string;
  readonly sliceNumber: number;
  readonly slices: readonly Slice[];
  readonly groupName: string;
};

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
  phase: Phase = { kind: "Idle" };
  tddAgent: AgentHandle | null = null;
  reviewAgent: AgentHandle | null = null;
  verifyAgent: AgentHandle | null = null;
  gapAgent: AgentHandle | null = null;
  retryDelayMs = 5_000;
  minAgentDurationMs = 3_000;
  usageProbeDelayMs = 60_000;
  usageProbeMaxDelayMs = 300_000;
  tddIsFirst = true;
  reviewIsFirst = true;
  sliceSkipFlag = false;
  quitRequested = false;
  hardInterruptPending: string | null = null;
  slicesCompleted = 0;
  currentDirectRequestContent: string | null = null;

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

  private sliceUnit(slice: Slice, groupName: string): ExecutionUnit {
    return {
      kind: "slice",
      label: `Slice ${slice.number}`,
      content: slice.content,
      sliceNumber: slice.number,
      slices: [slice],
      groupName,
    };
  }

  private groupedUnit(group: Group): ExecutionUnit {
    const representativeSliceNumber = group.slices[group.slices.length - 1]?.number ?? 0;
    const groupContent = group.slices
      .map((slice) => `### Slice ${slice.number}: ${slice.title}\n\n${slice.content}`)
      .join("\n\n---\n\n");

    return {
      kind: "group",
      label: `Group ${group.name}`,
      content: groupContent,
      sliceNumber: representativeSliceNumber,
      slices: group.slices,
      groupName: group.name,
    };
  }

  private directUnit(requestContent: string, representativeSliceNumber: number): ExecutionUnit {
    return {
      kind: "direct",
      label: "Direct request",
      content: requestContent,
      sliceNumber: representativeSliceNumber,
      slices: [],
      groupName: "Direct",
    };
  }

  private currentTier(): ComplexityTier {
    return this.state.activeTier ?? this.state.tier ?? this.config.tier;
  }

  private systemPromptForRole(role: AgentRole): string | undefined {
    const skillRole = this.agentRoleToSkillRole(role);
    if (skillRole === null) {
      return undefined;
    }
    return this.rolePromptResolver.resolve(skillRole, this.currentTier()) ?? undefined;
  }

  private agentRoleToSkillRole(role: AgentRole): SkillRole | null {
    switch (role) {
      case "tdd":
      case "review":
      case "verify":
      case "plan":
      case "gap":
      case "completeness":
        return role;
      case "final":
      case "triage":
        return null;
    }
  }

  private spawnAgent(
    role: AgentRole,
    opts?: {
      readonly resumeSessionId?: string;
      readonly cwd?: string;
      readonly planMode?: boolean;
      readonly model?: string;
    },
  ): AgentHandle {
    return this.agents.spawn(role, {
      ...opts,
      systemPrompt: this.systemPromptForRole(role),
    });
  }

  private async persistPolicyState(update: {
    readonly activeTier: ComplexityTier;
    readonly currentGroupBaseSha?: string;
    readonly pendingVerifyBaseSha?: string;
    readonly pendingCompletenessBaseSha?: string;
    readonly pendingReviewBaseSha?: string;
    readonly pendingGapBaseSha?: string;
  }): Promise<void> {
    await this.persistStateEvent({
      kind: "policyUpdated",
      activeTier: update.activeTier,
      currentGroupBaseSha: update.currentGroupBaseSha,
      pendingVerifyBaseSha: update.pendingVerifyBaseSha,
      pendingCompletenessBaseSha: update.pendingCompletenessBaseSha,
      pendingReviewBaseSha: update.pendingReviewBaseSha,
      pendingGapBaseSha: update.pendingGapBaseSha,
    });
  }

  private async openGroupPolicyWindow(groupName: string, groupBaseSha: string): Promise<void> {
    const resumingCurrentGroup =
      this.state.currentGroup === groupName && this.state.currentGroupBaseSha !== undefined;

    if (resumingCurrentGroup) {
      return;
    }

    await this.persistPolicyState({
      activeTier: this.currentTier(),
      currentGroupBaseSha: groupBaseSha,
      pendingVerifyBaseSha: undefined,
      pendingCompletenessBaseSha: undefined,
      pendingReviewBaseSha: undefined,
      pendingGapBaseSha: undefined,
    });
  }

  private async clearGroupPolicyWindow(): Promise<void> {
    await this.persistPolicyState({
      activeTier: this.currentTier(),
      currentGroupBaseSha: undefined,
      pendingVerifyBaseSha: undefined,
      pendingCompletenessBaseSha: undefined,
      pendingReviewBaseSha: undefined,
      pendingGapBaseSha: undefined,
    });
  }

  private async clearDeferredEvaluatorSessions(): Promise<void> {
    if (this.verifyAgent) {
      this.verifyAgent.kill();
      this.verifyAgent = null;
    }
    if (this.gapAgent) {
      this.gapAgent.kill();
      this.gapAgent = null;
    }
    this.state = advanceState(this.state, { kind: "groupAgentsCleared" });
    await this.persistence.save(this.state);
  }

  private async setPendingBase(
    pass: "verify" | "completeness" | "review" | "gap",
    sha: string | undefined,
  ): Promise<void> {
    await this.persistPolicyState({
      activeTier: this.currentTier(),
      currentGroupBaseSha: this.state.currentGroupBaseSha,
      pendingVerifyBaseSha: pass === "verify" ? sha : this.state.pendingVerifyBaseSha,
      pendingCompletenessBaseSha:
        pass === "completeness" ? sha : this.state.pendingCompletenessBaseSha,
      pendingReviewBaseSha: pass === "review" ? sha : this.state.pendingReviewBaseSha,
      pendingGapBaseSha: pass === "gap" ? sha : this.state.pendingGapBaseSha,
    });
  }

  private async respawnTierSensitiveAgents(): Promise<void> {
    await this.clearDeferredEvaluatorSessions();
    if (this.tddAgent) {
      this.tddAgent.kill();
    }
    if (this.reviewAgent) {
      this.reviewAgent.kill();
    }
    this.tddAgent = this.spawnAgent("tdd", { cwd: this.config.cwd });
    this.reviewAgent = this.spawnAgent("review", { cwd: this.config.cwd });
    this.pipeToSink(this.tddAgent, "tdd");
    this.pipeToSink(this.reviewAgent, "review");
    await Promise.all([
      this.tddAgent.sendQuiet(this.prompts.rulesReminder("tdd")),
      this.reviewAgent.sendQuiet(this.prompts.rulesReminder("review")),
    ]);
    this.tddIsFirst = true;
    this.reviewIsFirst = true;
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "tdd",
      session: this.currentSession("tdd"),
    });
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "review",
      session: this.currentSession("review"),
    });
    await this.persistence.save(this.state);
  }

  private async prepareTierForUnit(
    unit: ExecutionUnit,
    options?: { readonly preserveCurrentUnitTier?: boolean },
  ): Promise<void> {
    if (options?.preserveCurrentUnitTier) {
      return;
    }

    const selectedTier = await this.tierSelector.select({
      mode: this.config.executionMode,
      unitKind: unit.kind,
      content: unit.content,
    });
    this.progressSink.logBadge("triage", `tier=${selectedTier.tier} (${selectedTier.reason})`);

    const previousTier = this.currentTier();
    await this.persistPolicyState({
      activeTier: selectedTier.tier,
      currentGroupBaseSha: this.state.currentGroupBaseSha,
      pendingVerifyBaseSha: this.state.pendingVerifyBaseSha,
      pendingCompletenessBaseSha: this.state.pendingCompletenessBaseSha,
      pendingReviewBaseSha: this.state.pendingReviewBaseSha,
      pendingGapBaseSha: this.state.pendingGapBaseSha,
    });

    if (selectedTier.tier !== previousTier) {
      await this.respawnTierSensitiveAgents();
    }
  }

  private isResumingSliceUnit(unit: ExecutionUnit): boolean {
    return (
      unit.kind === "slice" &&
      this.state.currentPhase !== undefined &&
      this.state.currentSlice === unit.sliceNumber &&
      this.state.currentGroup === unit.groupName &&
      this.state.lastCompletedSlice !== unit.sliceNumber
    );
  }

  private isResumingGroupedUnit(unit: ExecutionUnit): boolean {
    return (
      unit.kind === "group" &&
      this.state.currentPhase !== undefined &&
      this.state.currentGroup === unit.groupName &&
      this.state.currentSlice === unit.sliceNumber &&
      this.state.lastCompletedGroup !== unit.groupName
    );
  }

  private isResumingDirectUnit(): boolean {
    return this.config.executionMode === "direct" && this.state.currentPhase !== undefined;
  }

  private failIncompleteExecutionUnit(unit: ExecutionUnit, reason: string): never {
    this.phase = { kind: "Idle" };
    this.sliceSkipFlag = false;
    throw new IncompleteRunError(`${unit.label} did not complete: ${reason}`);
  }

  private summaryPromptForUnit(unit: ExecutionUnit): string {
    if (unit.kind === "group") {
      return `Summarise what you just built for ${unit.label} in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.`;
    }

    if (unit.kind === "direct") {
      return "Summarise what you just built for the direct request in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.";
    }

    return `Summarise what you just built for Slice ${unit.sliceNumber} in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.`;
  }

  private verifyPromptForUnit(
    unit: ExecutionUnit,
    verifyBaseSha: string,
    fixSummary?: string,
  ): string {
    if (unit.kind === "direct") {
      return this.prompts.directVerify(verifyBaseSha, unit.content, fixSummary);
    }

    if (unit.kind === "group") {
      return this.prompts.groupedVerify(verifyBaseSha, unit.groupName, fixSummary);
    }

    return this.prompts.verify(verifyBaseSha, unit.sliceNumber, fixSummary);
  }

  private reviewPromptForUnit(
    unit: ExecutionUnit,
    reviewBaseSha: string,
    followUp = false,
  ): string {
    if (unit.kind !== "direct") {
      return this.prompts.review(unit.content, reviewBaseSha, followUp);
    }

    return this.prompts.directReview(unit.content, reviewBaseSha, followUp);
  }

  private completenessPromptForUnit(unit: ExecutionUnit, baseSha: string): string {
    if (unit.kind === "direct") {
      return this.prompts.directCompleteness(unit.content, baseSha);
    }

    if (unit.kind === "group") {
      return this.prompts.groupedCompleteness(unit.content, baseSha, unit.groupName);
    }

    return this.prompts.completeness(unit.content, baseSha, unit.sliceNumber);
  }

  private gapPromptForRun(groupContent: string, groupBaseSha: string): string {
    if (this.currentDirectRequestContent === null) {
      return this.prompts.withBrief(this.prompts.gap(groupContent, groupBaseSha));
    }

    return this.prompts.directGap(this.currentDirectRequestContent);
  }

  private gapFixPrompt(groupContent: string, gapText: string): string {
    if (this.currentDirectRequestContent === null) {
      return this.prompts.tdd(
        groupContent,
        `A gap analysis found missing test coverage. Add the missing tests.\n\n## Gaps Found\n${gapText}\n\nAdd tests for each gap. Do NOT refactor or change existing code — only add tests.`,
      );
    }

    return `A gap analysis found missing test coverage for the direct request. Add the missing tests.

## Current direct request
${this.currentDirectRequestContent}

## Gaps Found
${gapText}

Add tests for each gap. Do NOT refactor or change existing code unless a test exposes a real defect in the direct request implementation.`;
  }

  private finalPassesForRun(runBaseSha: string): readonly FinalPass[] {
    if (this.currentDirectRequestContent === null) {
      return this.prompts.finalPasses(runBaseSha);
    }

    return this.prompts.directFinalPasses(runBaseSha, this.currentDirectRequestContent);
  }

  private finalFixPrompt(pass: FinalPass, findings: string): string {
    if (this.currentDirectRequestContent === null) {
      return this.prompts.tdd(
        this.config.planContent,
        `A final "${pass.name}" review found issues. Address them.\n\n## Findings\n${findings}`,
      );
    }

    return `A final "${pass.name}" review found issues in the direct request implementation. Address them.

## Current direct request
${this.currentDirectRequestContent}

## Findings
${findings}

Rules:
- Keep fixes scoped to this direct request.
- Do not reframe the work as a plan slice, group, or generated plan.
- Treat each concrete finding as an implementation obligation unless you can prove it is incorrect with code and passing tests.`;
  }

  private formatVerifyFailureSummary(result: VerifyResult): string {
    const parts = [result.summary];

    if (result.sliceLocalFailures.length > 0) {
      parts.push(`Slice-local failures:\n${result.sliceLocalFailures.join("\n")}`);
    }
    if (result.outOfScopeFailures.length > 0) {
      parts.push(`Out-of-scope failures:\n${result.outOfScopeFailures.join("\n")}`);
    }
    if (result.preExistingFailures.length > 0) {
      parts.push(`Pre-existing failures:\n${result.preExistingFailures.join("\n")}`);
    }
    if (result.runnerIssue) {
      parts.push(`Runner issue:\n${result.runnerIssue}`);
    }

    return parts.join("\n\n");
  }

  private async markExecutionUnitComplete(unit: ExecutionUnit): Promise<void> {
    if (unit.kind === "direct") {
      this.progressSink.updateProgress({ activeAgent: undefined, activeAgentActivity: undefined });
      return;
    }

    for (const slice of unit.slices) {
      this.state = advanceState(this.state, { kind: "sliceDone", sliceNumber: slice.number });
      await this.persistence.save(this.state);
      this.logOrch(`Completed slice ${slice.number}`);
      this.slicesCompleted++;
    }
    this.progressSink.updateProgress({ activeAgent: undefined, activeAgentActivity: undefined });
  }

  private async persistRunState(): Promise<void> {
    const modeAwareState =
      this.config.executionMode === "direct"
        ? {
            ...this.state,
            currentSlice: undefined,
            currentGroup: undefined,
            sliceTimings: undefined,
            lastCompletedSlice: undefined,
            lastCompletedGroup: undefined,
            lastSliceImplemented: undefined,
            reviewBaseSha: undefined,
            currentGroupBaseSha: undefined,
            pendingVerifyBaseSha: undefined,
            pendingCompletenessBaseSha: undefined,
            pendingReviewBaseSha: undefined,
            pendingGapBaseSha: undefined,
          }
        : this.state;

    this.state = {
      ...modeAwareState,
      completedAt: undefined,
      executionMode: this.config.executionMode,
      tier: this.currentTier(),
      activeTier: this.currentTier(),
    };
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "tdd",
      session: this.currentSession("tdd"),
    });
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "review",
      session: this.currentSession("review"),
    });
    await this.persistence.save(this.state);
  }

  private pendingBaseFor(pass: "verify" | "completeness" | "review" | "gap"): string | undefined {
    switch (pass) {
      case "verify":
        return this.state.pendingVerifyBaseSha;
      case "completeness":
        return this.state.pendingCompletenessBaseSha;
      case "review":
        return this.state.pendingReviewBaseSha;
      case "gap":
        return this.state.pendingGapBaseSha;
    }
  }

  private normalizeBoundaryDecision(decision: PassDecision, finalBoundary: boolean): PassDecision {
    if (finalBoundary && shouldDeferPass(decision)) {
      return "run_now";
    }
    return decision;
  }

  private async triageBoundary(opts: {
    unitKind: ExecutionUnitKind;
    baseSha: string;
    finalBoundary: boolean;
    moreUnitsInGroup: boolean;
  }): Promise<BoundaryTriageResult> {
    const diff = await this.git.getDiff(opts.baseSha);
    const diffStats = await this.git.measureDiff(opts.baseSha);
    const pending = {
      verify:
        this.state.pendingVerifyBaseSha !== undefined &&
        (await this.git.hasChanges(this.state.pendingVerifyBaseSha)),
      completeness:
        this.state.pendingCompletenessBaseSha !== undefined &&
        (await this.git.hasChanges(this.state.pendingCompletenessBaseSha)),
      review:
        this.state.pendingReviewBaseSha !== undefined &&
        (await this.git.hasChanges(this.state.pendingReviewBaseSha)),
      gap:
        this.state.pendingGapBaseSha !== undefined &&
        (await this.git.hasChanges(this.state.pendingGapBaseSha)),
    };

    const triage = await this.triager.decide({
      mode: this.config.executionMode,
      unitKind: opts.unitKind,
      diff,
      diffStats,
      reviewThreshold: this.config.reviewThreshold,
      finalBoundary: opts.finalBoundary,
      moreUnitsInGroup: opts.moreUnitsInGroup,
      pending,
    });
    this.progressSink.logBadge("triage", triage.reason);
    return triage;
  }

  private async applyPassDecision(opts: {
    pass: "verify" | "completeness" | "review" | "gap";
    decision: PassDecision;
    defaultBaseSha: string;
    run: (baseSha: string) => Promise<boolean>;
  }): Promise<boolean> {
    const pendingBaseSha = this.pendingBaseFor(opts.pass);
    const baseSha = pendingBaseSha ?? opts.defaultBaseSha;

    if (shouldDeferPass(opts.decision)) {
      if (pendingBaseSha === undefined) {
        await this.setPendingBase(opts.pass, baseSha);
        return true;
      }

      const hasDeferredChanges = await this.git.hasChanges(baseSha);
      if (!hasDeferredChanges) {
        await this.setPendingBase(opts.pass, undefined);
        return true;
      }

      return true;
    }

    if (shouldSkipPass(opts.decision)) {
      if (pendingBaseSha !== undefined) {
        const hasDeferredChanges = await this.git.hasChanges(baseSha);
        if (!hasDeferredChanges) {
          await this.setPendingBase(opts.pass, undefined);
          return true;
        }
      }
      await this.setPendingBase(opts.pass, undefined);
      return true;
    }

    if (pendingBaseSha !== undefined) {
      const hasDeferredChanges = await this.git.hasChanges(baseSha);
      if (!hasDeferredChanges) {
        await this.setPendingBase(opts.pass, undefined);
        return true;
      }
    }

    const ok = await opts.run(baseSha);
    if (!ok) {
      return false;
    }

    await this.setPendingBase(opts.pass, undefined);
    return true;
  }

  private async applyBoundaryPolicy(opts: {
    unit: ExecutionUnit;
    group: Group;
    triageBaseSha: string;
    finalBoundary: boolean;
    moreUnitsInGroup: boolean;
    sendSummary: boolean;
    allowGap: boolean;
    onlyPendingPasses?: boolean;
    tddText?: string;
  }): Promise<{ skipped: boolean; triage: BoundaryTriageResult }> {
    if (opts.tddText !== undefined) {
      const noDeferredPasses =
        this.state.pendingVerifyBaseSha === undefined &&
        this.state.pendingCompletenessBaseSha === undefined &&
        this.state.pendingReviewBaseSha === undefined &&
        this.state.pendingGapBaseSha === undefined;
      const headAfterExecute = await this.git.captureRef();
      if (
        noDeferredPasses &&
        isAlreadyImplemented(opts.tddText, headAfterExecute, opts.triageBaseSha)
      ) {
        if (opts.sendSummary) {
          await this.tddAgent!.sendQuiet(this.summaryPromptForUnit(opts.unit));
        }
        return { skipped: false, triage: FULL_TRIAGE };
      }
    }

    const triage = await this.triageBoundary({
      unitKind: opts.unit.kind,
      baseSha: opts.triageBaseSha,
      finalBoundary: opts.finalBoundary,
      moreUnitsInGroup: opts.moreUnitsInGroup,
    });

    const pendingCompleteness = this.state.pendingCompletenessBaseSha !== undefined;
    const pendingVerify = this.state.pendingVerifyBaseSha !== undefined;
    const pendingReview = this.state.pendingReviewBaseSha !== undefined;
    const pendingGap = this.state.pendingGapBaseSha !== undefined;

    const completenessDecision =
      opts.onlyPendingPasses && !pendingCompleteness
        ? "skip"
        : this.config.skills.completeness === null
          ? "skip"
          : this.normalizeBoundaryDecision(triage.completeness, opts.finalBoundary);
    const verifyDecision =
      opts.onlyPendingPasses && !pendingVerify
        ? "skip"
        : this.config.skills.verify === null
          ? "skip"
          : this.normalizeBoundaryDecision(triage.verify, opts.finalBoundary);
    const reviewDecision =
      opts.onlyPendingPasses && !pendingReview
        ? "skip"
        : this.config.skills.review === null
          ? "skip"
          : this.normalizeBoundaryDecision(triage.review, opts.finalBoundary);
    const gapDecision =
      opts.onlyPendingPasses && !pendingGap
        ? "skip"
        : this.config.skills.gap === null
          ? "skip"
          : this.normalizeBoundaryDecision(triage.gap, opts.finalBoundary);

    const completenessOk = await this.applyPassDecision({
      pass: "completeness",
      decision: completenessDecision,
      defaultBaseSha: opts.triageBaseSha,
      run: async (baseSha) => {
        await this.completenessCheck(opts.unit, baseSha);
        return true;
      },
    });
    if (!completenessOk) {
      return { skipped: true, triage };
    }
    if (this.sliceSkipFlag) {
      return { skipped: true, triage };
    }

    const verifyOk = await this.applyPassDecision({
      pass: "verify",
      decision: verifyDecision,
      defaultBaseSha: opts.triageBaseSha,
      run: async (baseSha) => this.verify(opts.unit, baseSha),
    });
    if (!verifyOk) {
      return { skipped: true, triage };
    }
    if (this.sliceSkipFlag) {
      return { skipped: true, triage };
    }

    if (this.phase.kind === "CompletenessCheck") {
      this.phase = transition(this.phase, { kind: "CompletenessOk" });
    }
    if (this.phase.kind === "Verifying") {
      this.phase = transition(this.phase, { kind: "VerifyPassed" });
    }

    const reviewOk = await this.applyPassDecision({
      pass: "review",
      decision: reviewDecision,
      defaultBaseSha: opts.triageBaseSha,
      run: async (baseSha) => {
        if (this.config.skills.review === null) {
          return true;
        }
        await this.reviewFix(opts.unit, baseSha);
        return true;
      },
    });
    if (!reviewOk) {
      return { skipped: true, triage };
    }
    if (this.sliceSkipFlag) {
      return { skipped: true, triage };
    }
    if (this.phase.kind === "Reviewing") {
      this.phase = transition(this.phase, { kind: "ReviewClean" });
    }

    const canRunGap = opts.allowGap && opts.unit.kind !== "slice";
    const gapOk = await this.applyPassDecision({
      pass: "gap",
      decision: canRunGap ? gapDecision : "defer",
      defaultBaseSha: opts.triageBaseSha,
      run: async (baseSha) => {
        await this.gapAnalysis(opts.group, baseSha);
        return true;
      },
    });
    if (!gapOk) {
      return { skipped: true, triage };
    }
    if (this.sliceSkipFlag) {
      return { skipped: true, triage };
    }

    if (opts.unit.kind !== "direct") {
      this.state = advanceState(this.state, {
        kind: "sliceImplemented",
        sliceNumber: opts.unit.sliceNumber,
        reviewBaseSha: this.state.pendingReviewBaseSha ?? opts.triageBaseSha,
        pendingVerifyBaseSha: this.state.pendingVerifyBaseSha,
        pendingCompletenessBaseSha: this.state.pendingCompletenessBaseSha,
        pendingGapBaseSha: this.state.pendingGapBaseSha,
      });
      await this.persistence.save(this.state);
    }

    if (opts.sendSummary) {
      await this.tddAgent!.sendQuiet(this.summaryPromptForUnit(opts.unit));
    }
    return { skipped: false, triage };
  }

  private async flushDeferredGroupPasses(
    group: Group,
    groupBaseSha: string,
    forceGroupBoundary = false,
  ): Promise<void> {
    const unit = this.groupedUnit(group);
    const hasPendingPasses =
      this.state.pendingVerifyBaseSha !== undefined ||
      this.state.pendingCompletenessBaseSha !== undefined ||
      this.state.pendingReviewBaseSha !== undefined ||
      this.state.pendingGapBaseSha !== undefined;

    if (!hasPendingPasses && !forceGroupBoundary) {
      return;
    }

    if (!hasPendingPasses && forceGroupBoundary) {
      if (this.config.skills.gap !== null && (await this.git.hasChanges(groupBaseSha))) {
        await this.gapAnalysis(group, groupBaseSha);
      }
      return;
    }

    const result = await this.applyBoundaryPolicy({
      unit,
      group,
      triageBaseSha: groupBaseSha,
      finalBoundary: true,
      moreUnitsInGroup: false,
      sendSummary: false,
      allowGap: true,
      onlyPendingPasses: hasPendingPasses,
    });

    if (result.skipped) {
      this.failIncompleteExecutionUnit(unit, "deferred group-end passes did not complete");
    }
  }

  private async runDirectExecution(group: Group, reviewBase: string): Promise<void> {
    if (group.slices.length === 0) {
      return;
    }

    const fullContent = group.slices.map((s) => s.content).join("\n\n---\n\n");
    const lastSlice = group.slices[group.slices.length - 1]!;
    const directUnit = this.directUnit(fullContent, lastSlice.number);
    await this.prepareTierForUnit(directUnit, {
      preserveCurrentUnitTier: this.isResumingDirectUnit(),
    });

    this.sliceSkipFlag = false;
    this.progressSink.clearSkipping();
    await this.persistPolicyState({
      activeTier: this.currentTier(),
      currentGroupBaseSha: reviewBase,
      pendingVerifyBaseSha: undefined,
      pendingCompletenessBaseSha: undefined,
      pendingReviewBaseSha: undefined,
      pendingGapBaseSha: undefined,
    });

    // Execute each slice sequentially — no verification between slices
    let lastTddText: string | undefined;
    for (const slice of group.slices) {
      const unit = this.directUnit(slice.content, slice.number);
      this.phase = transition(this.phase, { kind: "StartPlanning", sliceNumber: unit.sliceNumber });

      let pteResult = await this.planThenExecute(unit.content, unit.sliceNumber);
      if (pteResult.replan) {
        pteResult = await this.planThenExecute(unit.content, unit.sliceNumber, true);
      }

      if (pteResult.skipped) {
        this.failIncompleteExecutionUnit(unit, "execution was skipped before delivery");
      }

      let tddResult = pteResult.tddResult;

      if (pteResult.hardInterrupt) {
        const guidance = pteResult.hardInterrupt;
        this.hardInterruptPending = null;
        await this.respawnTdd();
        this.progressSink.logBadge("tdd", "implementing...");
        await this.enterPhase("tdd", unit.sliceNumber);
        tddResult = await this.withRetry(
          () => this.tddAgent!.send(this.prompts.withBrief(guidance)),
          this.tddAgent!,
          "tdd",
          "tdd-interrupt",
        );
        this.phase = { kind: "Verifying", sliceNumber: unit.sliceNumber };
      }

      this.tddIsFirst = false;

      if (tddResult.needsInput) {
        await this.followUp(tddResult, this.tddAgent!);
      }

      await this.commitSweep(unit.label);
      lastTddText = tddResult.assistantText;
      this.progressSink.logBadge("tdd", `slice ${slice.number} done`);
    }

    // Run the expensive passes once at the end using the full direct request.
    const directResult = await this.applyBoundaryPolicy({
      unit: directUnit,
      group,
      triageBaseSha: reviewBase,
      finalBoundary: true,
      moreUnitsInGroup: false,
      sendSummary: true,
      allowGap: true,
      tddText: lastTddText,
    });
    this.phase = { kind: "Idle" };

    if (directResult.skipped) {
      this.failIncompleteExecutionUnit(directUnit, "boundary policy did not complete");
    }
  }

  private failIncompleteSlice(slice: Slice, reason: string): never {
    this.phase = { kind: "Idle" };
    this.sliceSkipFlag = false;
    throw new IncompleteRunError(`Slice ${slice.number} did not complete: ${reason}`);
  }

  private canSkipCurrentSlice(): boolean {
    return "sliceNumber" in this.phase;
  }

  private pipeToSink(agent: AgentHandle, role: AgentRole): void {
    const streamer = this.progressSink.createStreamer(role);
    agent.pipe(
      (text) => {
        streamer(text);
        this.logWriter.write(role, text);
      },
      (summary) => this.progressSink.setActivity(summary),
    );
  }

  private logOrch(text: string): void {
    this.logWriter.write("ORCH", text);
  }

  private async persistStateEvent(event: StateEvent): Promise<void> {
    this.state = advanceState(this.state, event);
    await this.persistence.save(this.state);
  }

  private async enterPhase(phase: PersistedPhase, sliceNumber: number): Promise<void> {
    this.logOrch(`Entered phase ${phase} for slice ${sliceNumber}`);
    await this.persistStateEvent({ kind: "phaseEntered", phase, sliceNumber });
  }

  private async clearPersistedPhase(): Promise<void> {
    if (this.state.currentPhase === undefined && this.state.completedAt !== undefined) {
      return;
    }
    this.state = {
      ...this.state,
      currentPhase: undefined,
      completedAt: this.state.completedAt ?? new Date().toISOString(),
      verifySession: undefined,
      gapSession: undefined,
    };
    await this.persistence.save(this.state);
  }

  private currentSliceNumber(defaultSliceNumber = 0): number {
    return this.state.currentSlice ?? this.state.lastCompletedSlice ?? defaultSliceNumber;
  }

  private providerForRole(role: "tdd" | "review" | "verify" | "gap"): Provider {
    return this.config.agentConfig[role].provider;
  }

  private sessionForRole(
    role: "tdd" | "review" | "verify" | "gap",
  ): PersistedAgentSession | undefined {
    const session =
      role === "tdd"
        ? this.state.tddSession
        : role === "review"
          ? this.state.reviewSession
          : role === "verify"
            ? this.state.verifySession
            : this.state.gapSession;
    if (session?.provider !== this.providerForRole(role)) {
      return undefined;
    }
    return session;
  }

  private currentSession(role: "tdd" | "review" | "verify" | "gap"): PersistedAgentSession {
    const agent =
      role === "tdd"
        ? this.tddAgent
        : role === "review"
          ? this.reviewAgent
          : role === "verify"
            ? this.verifyAgent
            : this.gapAgent;
    if (!agent) {
      throw new Error(`Missing ${role} agent`);
    }
    return { provider: this.providerForRole(role), id: agent.sessionId };
  }

  private async sendRulesReminder(role: "tdd" | "review"): Promise<void> {
    const agent = role === "tdd" ? this.tddAgent : this.reviewAgent;
    if (!agent) {
      throw new Error(`Missing ${role} agent`);
    }
    await agent.sendQuiet(this.prompts.rulesReminder(role));
  }

  private async respawnReview(): Promise<void> {
    if (this.reviewAgent) {
      this.reviewAgent.kill();
    }
    this.reviewAgent = this.spawnAgent("review", { cwd: this.config.cwd });
    this.pipeToSink(this.reviewAgent, "review");
    await this.sendRulesReminder("review");
    this.reviewIsFirst = true;
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "review",
      session: this.currentSession("review"),
    });
    await this.persistence.save(this.state);
  }

  private async respawnVerify(): Promise<void> {
    if (this.verifyAgent) {
      this.verifyAgent.kill();
    }
    this.verifyAgent = this.spawnAgent("verify", {
      resumeSessionId: this.sessionForRole("verify")?.id,
      cwd: this.config.cwd,
    });
    this.pipeToSink(this.verifyAgent, "verify");
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "verify",
      session: this.currentSession("verify"),
    });
    await this.persistence.save(this.state);
  }

  private async respawnGap(): Promise<void> {
    if (this.gapAgent) {
      this.gapAgent.kill();
    }
    this.gapAgent = this.spawnAgent("gap", {
      resumeSessionId: this.sessionForRole("gap")?.id,
      cwd: this.config.cwd,
    });
    this.pipeToSink(this.gapAgent, "gap");
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "gap",
      session: this.currentSession("gap"),
    });
    await this.persistence.save(this.state);
  }

  private async respawnRole(role: AgentRole): Promise<void> {
    if (role === "tdd") {
      await this.respawnTdd();
    } else if (role === "review") {
      await this.respawnReview();
    } else if (role === "verify") {
      await this.respawnVerify();
    } else {
      await this.respawnGap();
    }
  }

  private agentForRole(role: AgentRole): AgentHandle | null {
    if (role === "tdd") {
      return this.tddAgent;
    }
    if (role === "review") {
      return this.reviewAgent;
    }
    if (role === "verify") {
      return this.verifyAgent;
    }
    if (role === "gap") {
      return this.gapAgent;
    }
    return null;
  }

  private async ensureGroupScopedAgent(role: "verify" | "gap"): Promise<AgentHandle> {
    const existing = role === "verify" ? this.verifyAgent : this.gapAgent;
    if (existing) {
      return existing;
    }

    if (role === "verify") {
      await this.respawnVerify();
      return this.verifyAgent!;
    }

    await this.respawnGap();
    return this.gapAgent!;
  }

  private async validateOrRefreshResumedAgent(
    role: "tdd" | "review" | "verify" | "gap",
  ): Promise<"resumed" | "fresh" | "none"> {
    const session = this.sessionForRole(role);
    if (!session) {
      return "none";
    }

    const agent =
      role === "tdd"
        ? this.tddAgent
        : role === "review"
          ? this.reviewAgent
          : role === "verify"
            ? this.verifyAgent
            : this.gapAgent;
    if (!agent) {
      throw new Error(`Missing ${role} agent`);
    }

    try {
      await agent.sendQuiet("Reply with exactly OK.");
      return "resumed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logOrch(
        `Failed to resume ${role} session for ${session.provider}; starting fresh (${message})`,
      );
      if (role === "tdd") {
        await this.respawnTdd();
      } else if (role === "review") {
        await this.respawnReview();
      } else if (role === "verify") {
        await this.respawnVerify();
      } else {
        await this.respawnGap();
      }
      return "fresh";
    }
  }

  dispose(): void {
    if (this.tddAgent) {
      this.tddAgent.kill();
    }
    if (this.reviewAgent) {
      this.reviewAgent.kill();
    }
    if (this.verifyAgent) {
      this.verifyAgent.kill();
    }
    if (this.gapAgent) {
      this.gapAgent.kill();
    }
    this.progressSink.teardown();
  }

  async execute(
    groups: readonly Group[],
    opts?: {
      onReady?: (info: { tddSessionId: string; reviewSessionId: string }) => void;
    },
  ): Promise<void> {
    try {
      this.progressSink.logExecutionMode(this.config.executionMode);

      if (groups.length === 0) {
        return;
      }

      this.state = await this.persistence.load();

      if (this.state.tddSession && this.state.tddSession.provider !== this.providerForRole("tdd")) {
        this.state = { ...this.state, tddSession: undefined };
      }
      if (
        this.state.reviewSession &&
        this.state.reviewSession.provider !== this.providerForRole("review")
      ) {
        this.state = { ...this.state, reviewSession: undefined };
      }
      if (
        this.state.verifySession &&
        this.state.verifySession.provider !== this.providerForRole("verify")
      ) {
        this.state = { ...this.state, verifySession: undefined };
      }
      if (this.state.gapSession && this.state.gapSession.provider !== this.providerForRole("gap")) {
        this.state = { ...this.state, gapSession: undefined };
      }

      // Spawn initial agents
      this.tddAgent = this.spawnAgent("tdd", {
        resumeSessionId: this.sessionForRole("tdd")?.id,
        cwd: this.config.cwd,
      });
      this.reviewAgent = this.spawnAgent("review", {
        resumeSessionId: this.sessionForRole("review")?.id,
        cwd: this.config.cwd,
      });
      this.pipeToSink(this.tddAgent, "tdd");
      this.pipeToSink(this.reviewAgent, "review");

      const resumedTdd = await this.validateOrRefreshResumedAgent("tdd");
      const resumedReview = await this.validateOrRefreshResumedAgent("review");
      const reminders: Promise<void>[] = [];
      if (resumedTdd === "none") {
        reminders.push(this.sendRulesReminder("tdd"));
      }
      if (resumedReview === "none") {
        reminders.push(this.sendRulesReminder("review"));
      }
      await Promise.all(reminders);

      if (resumedTdd === "resumed") {
        this.tddIsFirst = false;
      }
      if (resumedReview === "resumed") {
        this.reviewIsFirst = false;
      }

      opts?.onReady?.({
        tddSessionId: this.tddAgent.sessionId,
        reviewSessionId: this.reviewAgent.sessionId,
      });

      // Register keyboard interrupts
      const interrupts = this.progressSink.registerInterrupts();
      interrupts.onGuide((text) => {
        if (this.tddAgent) {
          this.tddAgent.inject(text);
        }
      });
      interrupts.onInterrupt((text) => {
        this.hardInterruptPending = text;
        if (this.tddAgent) {
          this.tddAgent.kill();
        }
      });
      interrupts.onSkip(() => {
        if (!this.canSkipCurrentSlice()) {
          return false;
        }
        this.sliceSkipFlag = !this.sliceSkipFlag;
        return true;
      });
      interrupts.onQuit(() => {
        this.quitRequested = true;
        if (this.tddAgent) {
          this.tddAgent.kill();
        }
      });

      const runBaseSha = await this.git.captureRef();

      await this.persistRunState();

      if (this.config.executionMode === "direct") {
        const directGroup = groups[0];
        if (!directGroup) {
          return;
        }
        this.currentDirectRequestContent = directGroup.slices
          .map((slice) => slice.content)
          .join("\n\n---\n\n");
        try {
          await this.runDirectExecution(directGroup, runBaseSha);
          await this.finalPasses(runBaseSha);
        } finally {
          this.currentDirectRequestContent = null;
        }
        return;
      }

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];

        const allSlicesDone =
          this.state.lastCompletedSlice !== undefined &&
          group.slices.every((s) => s.number <= this.state.lastCompletedSlice!);
        const groupAlreadyFinalized = this.state.lastCompletedGroup === group.name;

        // Skip entire group only when its slices and its post-slice group work are already complete
        if (allSlicesDone && groupAlreadyFinalized) {
          this.slicesCompleted += group.slices.length;
          this.progressSink.updateProgress({ completedSlices: this.slicesCompleted });
          continue;
        }

        this.progressSink.updateProgress({
          groupName: group.name,
          groupSliceCount: group.slices.length,
          groupCompleted: 0,
        });
        const groupBaseSha = this.state.currentGroupBaseSha ?? (await this.git.captureRef());
        await this.openGroupPolicyWindow(group.name, groupBaseSha);
        let groupCompleted = 0;
        let executedAnySliceThisGroup = false;

        if (this.config.executionMode === "grouped") {
          executedAnySliceThisGroup = true;
          const groupedResult = await this.runGroupedExecutionUnit(group, groupBaseSha);

          if (groupedResult.skipped) {
            this.failIncompleteExecutionUnit(
              this.groupedUnit(group),
              "boundary policy did not complete",
            );
          }

          groupCompleted = group.slices.length;
          this.progressSink.updateProgress({
            completedSlices: this.slicesCompleted,
            groupCompleted,
          });
        } else {
          for (const slice of group.slices) {
            // Reset skip state from previous slice
            this.sliceSkipFlag = false;
            this.progressSink.clearSkipping();

            if (this.quitRequested) {
              return;
            }

            if (
              this.state.lastCompletedSlice !== undefined &&
              slice.number <= this.state.lastCompletedSlice
            ) {
              this.slicesCompleted++;
              groupCompleted++;
              this.progressSink.updateProgress({
                completedSlices: this.slicesCompleted,
                groupCompleted,
              });
              continue;
            }

            const unit = this.sliceUnit(slice, group.name);
            await this.prepareTierForUnit(unit, {
              preserveCurrentUnitTier: this.isResumingSliceUnit(unit),
            });

            this.logOrch(`Starting slice ${slice.number} (${group.name})`);
            executedAnySliceThisGroup = true;
            await this.persistStateEvent({
              kind: "sliceStarted",
              sliceNumber: slice.number,
              groupName: group.name,
            });

            this.progressSink.updateProgress({
              currentSlice: { number: slice.number },
              completedSlices: this.slicesCompleted,
            });

            this.progressSink.logSliceIntro(slice);

            const sliceBaseSha = await this.git.captureRef();

            // Plan-then-execute with replan loop
            this.phase = transition(this.phase, {
              kind: "StartPlanning",
              sliceNumber: slice.number,
            });
            let replanAttempts = 0;
            let pteResult: PlanThenExecuteResult;
            do {
              pteResult = await this.planThenExecute(slice.content, slice.number);
              replanAttempts++;
            } while (pteResult.replan && replanAttempts < this.config.maxReplans);

            // After max replans, auto-accept
            if (pteResult.replan) {
              pteResult = await this.planThenExecute(slice.content, slice.number, true);
            }

            if (pteResult.skipped) {
              this.failIncompleteSlice(slice, "execution was skipped before delivery");
            }

            let tddResult = pteResult.tddResult;

            // Hard interrupt: agent was killed during plan or execute phase
            if (pteResult.hardInterrupt) {
              const guidance = pteResult.hardInterrupt;
              this.hardInterruptPending = null;
              await this.respawnTdd();
              this.progressSink.logBadge("tdd", "implementing...");
              await this.enterPhase("tdd", slice.number);
              tddResult = await this.withRetry(
                () => this.tddAgent!.send(this.prompts.withBrief(guidance)),
                this.tddAgent!,
                "tdd",
                "tdd-interrupt",
              );
              this.phase = { kind: "Verifying", sliceNumber: slice.number };
            }

            this.tddIsFirst = false;

            if (tddResult.needsInput) {
              await this.followUp(tddResult, this.tddAgent!);
            }

            // Commit sweep
            await this.commitSweep(`Slice ${slice.number}`);

            const sliceResult = await this.applyBoundaryPolicy({
              unit,
              group,
              triageBaseSha: sliceBaseSha,
              finalBoundary: false,
              moreUnitsInGroup: slice.number !== group.slices[group.slices.length - 1]?.number,
              sendSummary: true,
              allowGap: false,
              tddText: tddResult.assistantText,
            });
            this.phase = { kind: "Idle" };

            if (sliceResult.skipped) {
              this.failIncompleteSlice(slice, "boundary policy did not complete");
            }

            if (!sliceResult.skipped) {
              await this.markExecutionUnitComplete(unit);
              groupCompleted++;
              this.progressSink.updateProgress({
                completedSlices: this.slicesCompleted,
                groupCompleted,
              });
            }
          }
        }

        if (this.config.executionMode === "sliced") {
          await this.flushDeferredGroupPasses(
            group,
            groupBaseSha,
            !executedAnySliceThisGroup &&
              groupCompleted === group.slices.length &&
              this.state.lastCompletedGroup !== group.name,
          );
        }

        // Commit sweep
        await this.commitSweep(group.name);

        // Mark group complete
        this.state = advanceState(this.state, { kind: "groupDone", groupName: group.name });
        await this.persistence.save(this.state);
        await this.clearGroupPolicyWindow();

        // Inter-group transition
        if (i < groups.length - 1) {
          await this.respawnBoth();

          if (!this.config.auto) {
            const next = groups[i + 1];
            const nextLabel = `${next.name} (${next.slices.map((s) => `Slice ${s.number}`).join(", ")})`;
            const proceed = await this.gate.confirmNextGroup(nextLabel);
            if (!proceed) {
              return;
            }
          }
        }
      }

      // Final passes
      await this.finalPasses(runBaseSha);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logOrch(`Execution failed: ${message}`);
      throw error;
    } finally {
      await this.logWriter.close();
    }
  }

  async planThenExecute(
    sliceContent: string,
    sliceNumber: number,
    forceAccept = false,
  ): Promise<PlanThenExecuteResult> {
    if (this.config.executionMode === "direct") {
      this.phase = transition(this.phase, { kind: "PlanReady", planText: "" });
      this.phase = transition(this.phase, { kind: "PlanAccepted" });

      const directExecutePrompt = this.prompts.directExecute(sliceContent);
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", sliceNumber);
      const executeResult = await this.withRetry(
        () => this.tddAgent!.send(directExecutePrompt),
        this.tddAgent!,
        "tdd",
        "direct-execute",
      );

      if (executeResult.needsInput) {
        await this.followUp(executeResult, this.tddAgent!);
      }

      if (this.sliceSkipFlag) {
        this.phase = { kind: "Idle" };
        return { tddResult: executeResult, skipped: true };
      }

      const execInterrupt = this.hardInterruptPending;
      if (execInterrupt) {
        return { tddResult: executeResult, skipped: false, hardInterrupt: execInterrupt };
      }

      const directTestPassPrompt = this.prompts.directTestPass(sliceContent);
      this.progressSink.logBadge("tdd", "testing...");
      await this.enterPhase("tdd", sliceNumber);
      const testPassResult = await this.withRetry(
        () => this.tddAgent!.send(directTestPassPrompt),
        this.tddAgent!,
        "tdd",
        "direct-test-pass",
      );

      if (testPassResult.needsInput) {
        await this.followUp(testPassResult, this.tddAgent!);
      }

      if (this.sliceSkipFlag) {
        this.phase = { kind: "Idle" };
        return { tddResult: executeResult, skipped: true };
      }

      const testPassInterrupt = this.hardInterruptPending;
      if (testPassInterrupt) {
        return { tddResult: executeResult, skipped: false, hardInterrupt: testPassInterrupt };
      }

      this.tddIsFirst = false;
      this.phase = transition(this.phase, { kind: "ExecutionDone" });
      return { tddResult: executeResult, skipped: false };
    }

    if (this.config.skills.plan === null) {
      this.phase = transition(this.phase, { kind: "PlanReady", planText: "" });
      this.phase = transition(this.phase, { kind: "PlanAccepted" });

      const prompt = this.tddIsFirst
        ? this.prompts.withBrief(this.prompts.tdd(sliceContent, undefined, sliceNumber))
        : this.prompts.tdd(sliceContent, undefined, sliceNumber);
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", sliceNumber);
      const tddResult = await this.withRetry(
        () => this.tddAgent!.send(prompt),
        this.tddAgent!,
        "tdd",
        "tdd-direct",
      );
      this.tddIsFirst = false;
      this.phase = transition(this.phase, { kind: "ExecutionDone" });
      return { tddResult, skipped: false };
    }

    // ── Plan phase ──
    const planPrompt = this.prompts.plan(sliceContent, sliceNumber);
    this.progressSink.logBadge("tdd", "planning...");
    await this.enterPhase("plan", sliceNumber);
    const planResult = await this.withRetry(
      () => this.tddAgent!.send(planPrompt),
      this.tddAgent!,
      "tdd",
      "plan",
    );

    const plan = planResult.planText ?? planResult.assistantText ?? "";

    if (this.sliceSkipFlag) {
      this.phase = { kind: "Idle" };
      return { tddResult: planResult, skipped: true, planText: plan };
    }

    const hardInterruptGuidance = this.hardInterruptPending;
    if (hardInterruptGuidance) {
      this.phase = { kind: "Idle" };
      return {
        tddResult: planResult,
        skipped: false,
        hardInterrupt: hardInterruptGuidance,
        planText: plan,
      };
    }

    this.phase = transition(this.phase, { kind: "PlanReady", planText: plan });

    // ── Confirmation gate ──
    const skipConfirm = forceAccept || this.config.auto;
    let operatorGuidance: string | undefined;
    if (!skipConfirm) {
      const decision = await this.gate.confirmPlan(plan);
      if (decision.kind === "reject") {
        this.phase = transition(this.phase, { kind: "PlanRejected" });
        return { tddResult: planResult, skipped: false, replan: true, planText: plan };
      }
      if (decision.kind === "edit") {
        operatorGuidance = decision.guidance;
      }
    }

    this.phase = transition(this.phase, { kind: "PlanAccepted" });

    // ── Execute phase ──
    const executePrompt = this.prompts.tddExecute(
      plan,
      sliceNumber,
      this.tddIsFirst,
      operatorGuidance,
    );
    this.progressSink.logBadge("tdd", "implementing...");
    await this.enterPhase("tdd", sliceNumber);
    const tddResult = await this.withRetry(
      () => this.tddAgent!.send(executePrompt),
      this.tddAgent!,
      "tdd",
      "tdd-execute",
    );

    // Dead session fallback
    if (!this.tddAgent!.alive) {
      const deadSessionInterrupt = this.hardInterruptPending;
      if (deadSessionInterrupt) {
        this.phase = { kind: "Idle" };
        return { tddResult, skipped: false, hardInterrupt: deadSessionInterrupt, planText: plan };
      }
      await this.respawnTdd();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", sliceNumber);
      const retryResult = await this.withRetry(
        () => this.tddAgent!.send(executePrompt),
        this.tddAgent!,
        "tdd",
        "tdd-execute-retry",
      );
      this.phase = transition(this.phase, { kind: "ExecutionDone" });
      return { tddResult: retryResult, skipped: false, planText: plan };
    }

    if (this.sliceSkipFlag) {
      this.phase = { kind: "Idle" };
      return { tddResult, skipped: true, planText: plan };
    }

    const execInterrupt = this.hardInterruptPending;
    if (execInterrupt) {
      return { tddResult, skipped: false, hardInterrupt: execInterrupt, planText: plan };
    }

    this.tddIsFirst = false;
    this.phase = transition(this.phase, { kind: "ExecutionDone" });
    return { tddResult, skipped: false, planText: plan };
  }

  async runGroupedExecutionUnit(group: Group, groupBaseSha: string): Promise<{ skipped: boolean }> {
    const unit = this.groupedUnit(group);
    await this.prepareTierForUnit(unit, {
      preserveCurrentUnitTier: this.isResumingGroupedUnit(unit),
    });
    this.sliceSkipFlag = false;
    this.progressSink.clearSkipping();

    if (this.quitRequested) {
      return { skipped: true };
    }

    await this.persistStateEvent({
      kind: "groupStarted",
      groupName: unit.groupName,
      sliceNumber: unit.sliceNumber,
    });

    this.progressSink.updateProgress({
      currentSlice: { number: unit.sliceNumber },
      completedSlices: this.slicesCompleted,
    });

    const executePrompt = this.prompts.groupedExecute(
      unit.groupName,
      unit.content,
      this.tddIsFirst,
    );
    this.phase = { kind: "Executing", sliceNumber: unit.sliceNumber, planText: null };
    this.progressSink.logBadge("tdd", "implementing...");
    await this.enterPhase("tdd", unit.sliceNumber);
    const executeResult = await this.withRetry(
      () => this.tddAgent!.send(executePrompt),
      this.tddAgent!,
      "tdd",
      "group-execute",
    );
    this.tddIsFirst = false;

    if (executeResult.needsInput) {
      await this.followUp(executeResult, this.tddAgent!);
    }

    if (this.sliceSkipFlag) {
      return { skipped: true };
    }

    const testPassPrompt = this.prompts.groupedTestPass(unit.groupName, unit.content);
    this.progressSink.logBadge("tdd", "testing...");
    await this.enterPhase("tdd", unit.sliceNumber);
    const testPassResult = await this.withRetry(
      () => this.tddAgent!.send(testPassPrompt),
      this.tddAgent!,
      "tdd",
      "group-test-pass",
    );

    if (testPassResult.needsInput) {
      await this.followUp(testPassResult, this.tddAgent!);
    }

    this.phase = transition(this.phase, { kind: "ExecutionDone" });

    await this.commitSweep(`Group ${unit.groupName}`);

    const result = await this.applyBoundaryPolicy({
      unit,
      group,
      triageBaseSha: groupBaseSha,
      finalBoundary: true,
      moreUnitsInGroup: false,
      sendSummary: true,
      allowGap: true,
      tddText: executeResult.assistantText,
    });

    if (!result.skipped) {
      await this.markExecutionUnitComplete(unit);
    }

    this.phase = { kind: "Idle" };
    return { skipped: result.skipped };
  }

  async reviewFix(unit: ExecutionUnit, baseSha: string): Promise<void> {
    let reviewSha = baseSha;

    if (this.phase.kind !== "Reviewing") {
      this.phase = transition(this.phase, {
        kind: "StartReview",
        sliceNumber: unit.sliceNumber,
      });
    }

    for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
      if (this.sliceSkipFlag) {
        break;
      }

      if (!(await this.git.hasChanges(reviewSha))) {
        break;
      }

      this.progressSink.updateProgress({
        activeAgent: "REV",
        activeAgentActivity: `reviewing (cycle ${cycle})...`,
      });

      const reviewPromptText = this.reviewPromptForUnit(unit, reviewSha, cycle > 1);
      const reviewPrompt = this.reviewIsFirst
        ? this.prompts.withBrief(reviewPromptText)
        : reviewPromptText;
      this.progressSink.logBadge("review", "reviewing...");
      await this.enterPhase("review", unit.sliceNumber);
      const reviewResult = await this.withRetry(
        () => this.reviewAgent!.send(reviewPrompt),
        this.reviewAgent!,
        "review",
        "review",
      );
      this.reviewIsFirst = false;
      const reviewText = reviewResult.assistantText;

      if (!reviewText || isCleanReview(reviewText)) {
        break;
      }

      this.phase = transition(this.phase, { kind: "ReviewIssues" });
      const preFixSha = await this.git.captureRef();
      const fixPrompt =
        unit.kind === "direct"
          ? `A code review found issues with the current direct request implementation. Address them.

## Current direct request
${unit.content}

## Review findings
${reviewText}

Rules:
- Keep fixes scoped to this direct request.
- Do not reframe the work as a plan slice or invent future work.
- Treat each concrete finding as an implementation obligation unless you can prove it is incorrect with code and passing tests.`
          : this.prompts.tdd(unit.content, reviewText, unit.sliceNumber);
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", unit.sliceNumber);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt),
        this.tddAgent!,
        "tdd",
        "review-fix",
      );
      this.tddIsFirst = false;

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent!);
      }

      if (!(await this.git.hasChanges(preFixSha))) {
        break;
      }

      reviewSha = preFixSha;
    }
  }

  async completenessCheck(unit: ExecutionUnit, baseSha: string): Promise<void> {
    if (this.sliceSkipFlag) {
      return;
    }
    if (!(await this.git.hasChanges(baseSha))) {
      return;
    }

    const prompt = this.completenessPromptForUnit(unit, baseSha);

    for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
      const checkAgent = this.spawnAgent("completeness", { cwd: this.config.cwd });
      this.pipeToSink(checkAgent, "completeness");
      await this.enterPhase("completeness", unit.sliceNumber);
      const result = await this.withRetry(
        () => checkAgent.send(prompt),
        checkAgent,
        "completeness",
        "completeness-check",
      );
      checkAgent.kill();

      const text = result.assistantText ?? "";
      const hasMissing = text.includes("❌") || text.includes("MISSING");
      const completionSentinel =
        unit.kind === "group"
          ? "GROUP_COMPLETE"
          : unit.kind === "direct"
            ? "DIRECT_COMPLETE"
            : "SLICE_COMPLETE";
      if (text.includes(completionSentinel) && !hasMissing) {
        if (this.phase.kind === "CompletenessCheck") {
          this.phase = transition(this.phase, { kind: "CompletenessOk" });
        }
        return;
      }

      if (this.phase.kind === "CompletenessCheck") {
        this.phase = transition(this.phase, { kind: "CompletenessIssues" });
      }

      const fixPrompt =
        unit.kind === "direct"
          ? `A completeness check found that your implementation does not fully match the direct request. Fix ALL issues below.

## Current direct request
${unit.content}

## Completeness Findings
${text}

Rules:
- ❌ MISSING items are HARD FAILURES. The direct request is the contract. Code that works but doesn't implement what was requested is NOT complete.
- ⚠️ DIVERGENT items mean your approach differs from the request's intent. Change your implementation to match the request, not the other way around.
- If the request says "use function X" or "call Y", your code must actually import and call X/Y. Passing tests are necessary but NOT sufficient.
- Do NOT argue that your approach is equivalent. Do NOT skip items because tests pass without them. Implement what the request says.`
          : this.prompts.tdd(
              unit.content,
              `A completeness check found that your implementation does not fully match the plan. Fix ALL issues below.\n\n## Completeness Findings\n${text}\n\nRules:\n- ❌ MISSING items are HARD FAILURES. The plan is the contract. Code that works but doesn't implement the plan's specified approach is NOT complete. You must implement what the plan says, not an alternative that passes tests.\n- ⚠️ DIVERGENT items mean your approach differs from the plan's intent. Change your implementation to match the plan, not the other way around.\n- If the plan says "use function X" or "call Y", your code must actually import and call X/Y. Passing tests are necessary but NOT sufficient — the plan's architectural requirements are equally binding.\n- Do NOT argue that your approach is equivalent. Do NOT skip items because tests pass without them. Implement what the plan says.`,
              unit.sliceNumber,
            );
      const preFixSha = await this.git.captureRef();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", unit.sliceNumber);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt),
        this.tddAgent!,
        "tdd",
        "completeness-fix",
      );
      this.tddIsFirst = false;

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent!);
      }

      this.phase = transition(this.phase, { kind: "ExecutionDone" });

      if (await this.git.hasChanges(preFixSha)) {
        await this.commitSweep(`${unit.label} completeness fix`);
      }
    }

    throw new IncompleteRunError(`${unit.label} completeness failed after retry budget`);
  }

  async verify(unit: ExecutionUnit, verifyBaseSha: string): Promise<boolean> {
    this.progressSink.updateProgress({ activeAgent: "VFY", activeAgentActivity: "verifying..." });

    const verifyAgent = await this.ensureGroupScopedAgent("verify");

    if (this.phase.kind === "CompletenessCheck") {
      this.phase = transition(this.phase, { kind: "CompletenessOk" });
    }

    const verifyPrompt = this.verifyPromptForUnit(unit, verifyBaseSha);
    this.progressSink.logBadge("verify", "verifying...");
    await this.enterPhase("verify", unit.sliceNumber);
    const verifyResult = await this.withRetry(
      () => verifyAgent.send(verifyPrompt),
      verifyAgent,
      "verify",
      "verify",
    );
    let parsed = parseVerifyResult(verifyResult.assistantText ?? "");

    for (let cycle = 1; !isVerifyPassing(parsed) && cycle <= this.config.maxReviewCycles; cycle++) {
      this.phase = transition(this.phase, { kind: "VerifyFailed" });

      const builderFixable = parsed.retryable && parsed.sliceLocalFailures.length > 0;
      const failureSummary = this.formatVerifyFailureSummary(parsed);

      if (!builderFixable) {
        if (this.config.auto) {
          throw new IncompleteRunError(`${unit.label} verification failed: ${parsed.summary}`);
        }

        const decision = await this.gate.verifyFailed(unit.label, failureSummary, false);
        if (decision.kind === "skip") {
          return false;
        }
        throw new IncompleteRunError(`${unit.label} verification failed and execution stopped`);
      }

      // Send findings to TDD for fixing
      const retryPrompt = `Verification found issues after your implementation. Fix them in ${unit.label}.\n\n## Current ${
        unit.kind === "group" ? "group" : unit.kind === "direct" ? "direct request" : "slice"
      } content\n${unit.content}\n\n## Slice-local failures\n${parsed.sliceLocalFailures.join("\n")}\n\n## Verification summary\n${parsed.summary}`;
      const preFixSha = await this.git.captureRef();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", unit.sliceNumber);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(retryPrompt),
        this.tddAgent!,
        "tdd",
        "verify-fix",
      );
      await this.checkCredit(fixResult, this.tddAgent!, "tdd");

      this.phase = { kind: "Verifying", sliceNumber: unit.sliceNumber };

      const tddMadeChanges = await this.git.hasChanges(preFixSha);

      if (!tddMadeChanges) {
        if (this.config.auto) {
          throw new IncompleteRunError(`${unit.label} verification failed without builder changes`);
        }

        const decision = await this.gate.verifyFailed(
          unit.label,
          `${failureSummary}\n\nBuilder made no relevant change.`,
          true,
        );

        if (decision.kind === "skip") {
          return false;
        }
        if (decision.kind === "stop") {
          throw new IncompleteRunError(`${unit.label} verification failed and execution stopped`);
        }
        continue;
      }

      // Re-verify — tell the verifier what TDD fixed
      const fixSummary = fixResult.assistantText?.slice(0, 500) ?? "TDD attempted fixes.";
      this.progressSink.logBadge("verify", "verifying...");
      await this.enterPhase("verify", unit.sliceNumber);
      const reVerifyResult = await this.withRetry(
        () => verifyAgent.send(this.verifyPromptForUnit(unit, verifyBaseSha, fixSummary)),
        verifyAgent,
        "verify",
        "re-verify",
      );
      parsed = parseVerifyResult(reVerifyResult.assistantText ?? "");

      if (!isVerifyPassing(parsed) && !this.config.auto) {
        const nextBuilderFixable = parsed.retryable && parsed.sliceLocalFailures.length > 0;
        const decision = await this.gate.verifyFailed(
          unit.label,
          this.formatVerifyFailureSummary(parsed),
          nextBuilderFixable,
        );

        if (decision.kind === "skip") {
          return false;
        }
        if (decision.kind === "stop") {
          throw new IncompleteRunError(`${unit.label} verification failed and execution stopped`);
        }
        continue;
      }
    }

    if (!isVerifyPassing(parsed)) {
      throw new IncompleteRunError(`${unit.label} verification failed after retry budget`);
    }

    if (this.phase.kind === "Verifying") {
      this.phase = transition(this.phase, { kind: "VerifyPassed" });
    }

    return true;
  }

  async finalPasses(runBaseSha: string): Promise<void> {
    if (!(await this.git.hasChanges(runBaseSha))) {
      await this.clearPersistedPhase();
      return;
    }

    this.phase = transition(this.phase, { kind: "StartFinalPasses" });

    const passes = this.finalPassesForRun(runBaseSha);

    for (const pass of passes) {
      let passClean = false;

      for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
        const finalAgent = this.spawnAgent("final", { cwd: this.config.cwd });
        this.pipeToSink(finalAgent, "final");
        const finalPrompt = this.prompts.withBrief(pass.prompt);
        this.progressSink.logBadge("final", "finalising...");
        await this.enterPhase("final", this.currentSliceNumber());
        const finalResult = await this.withRetry(
          () => finalAgent.send(finalPrompt),
          finalAgent,
          "final",
          "final-pass",
        );
        finalAgent.kill();

        if (finalResult.exitCode !== 0) {
          continue;
        }
        const findings = finalResult.assistantText ?? "";
        if (!findings || findings.includes("NO_ISSUES_FOUND")) {
          passClean = true;
          break;
        }

        const fixPrompt = this.finalFixPrompt(pass, findings);
        const actualFixPrompt = this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt;
        const preFixSha = await this.git.captureRef();
        this.progressSink.logBadge("tdd", "implementing...");
        await this.enterPhase("tdd", this.currentSliceNumber());
        const fixResult = await this.withRetry(
          () => this.tddAgent!.send(actualFixPrompt),
          this.tddAgent!,
          "tdd",
          "final-fix",
        );
        this.tddIsFirst = false;
        await this.checkCredit(fixResult, this.tddAgent!, "tdd");

        if (fixResult.needsInput) {
          await this.followUp(fixResult, this.tddAgent!);
        }

        if (await this.git.hasChanges(preFixSha)) {
          await this.commitSweep(`${pass.name} final fix`);
        }
      }

      if (!passClean) {
        throw new IncompleteRunError(`Final pass "${pass.name}" failed after retry budget`);
      }
    }

    this.phase = transition(this.phase, { kind: "AllPassesDone" });
    await this.clearPersistedPhase();
  }

  async gapAnalysis(group: Group, groupBaseSha: string): Promise<void> {
    if (!(await this.git.hasChanges(groupBaseSha))) {
      return;
    }
    if (this.config.skills.gap === null) {
      return;
    }

    this.phase = transition(this.phase, { kind: "StartGap", groupName: group.name });

    const groupContent = group.slices.map((s) => s.content).join("\n\n---\n\n");
    const gapPrompt = this.gapPromptForRun(groupContent, groupBaseSha);
    const gapAgent = await this.ensureGroupScopedAgent("gap");
    const maxGapCycles = Math.min(this.config.maxReviewCycles, 2);

    for (let cycle = 1; cycle <= maxGapCycles; cycle++) {
      this.progressSink.logBadge("gap", "filling gaps...");
      await this.enterPhase(
        "gap",
        this.currentSliceNumber(group.slices[group.slices.length - 1]?.number ?? 0),
      );
      const gapResult = await this.withRetry(
        () => gapAgent.send(gapPrompt),
        gapAgent,
        "gap",
        "gap",
      );
      const gapText = gapResult.assistantText ?? "";

      if (gapResult.exitCode !== 0 || gapText.includes("NO_GAPS_FOUND")) {
        this.phase = transition(this.phase, { kind: "GapDone" });
        return;
      }

      const fixPrompt = this.gapFixPrompt(groupContent, gapText);
      const actualFixPrompt = this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt;
      const preFixSha = await this.git.captureRef();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase(
        "tdd",
        this.currentSliceNumber(group.slices[group.slices.length - 1]?.number ?? 0),
      );
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(actualFixPrompt),
        this.tddAgent!,
        "tdd",
        "gap-fix",
      );
      this.tddIsFirst = false;
      await this.checkCredit(fixResult, this.tddAgent!, "tdd");

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent!);
      }

      if (await this.git.hasChanges(preFixSha)) {
        await this.commitSweep(`${group.name} gap fixes`);
      }
    }

    // Final gap check — did the last TDD cycle actually resolve everything?
    this.progressSink.logBadge("gap", "final verification...");
    await this.enterPhase(
      "gap",
      this.currentSliceNumber(group.slices[group.slices.length - 1]?.number ?? 0),
    );
    const finalGapResult = await this.withRetry(
      () => gapAgent.send(gapPrompt),
      gapAgent,
      "gap",
      "gap-final",
    );
    const finalGapText = finalGapResult.assistantText ?? "";

    if (finalGapResult.exitCode !== 0 || finalGapText.includes("NO_GAPS_FOUND")) {
      this.phase = transition(this.phase, { kind: "GapDone" });
      return;
    }

    throw new IncompleteRunError(`${group.name} gap analysis failed after retry budget`);
  }

  async commitSweep(label: string): Promise<void> {
    const dirty = await this.git.hasDirtyTree();
    if (!dirty) {
      return;
    }
    if (!this.tddAgent?.alive) {
      return;
    }

    const prompt = this.prompts.commitSweep(label);
    const result = await this.withRetry(
      () => this.tddAgent!.send(prompt),
      this.tddAgent,
      "tdd",
      "commit-sweep",
    );

    if (result.needsInput) {
      await this.followUp(result, this.tddAgent);
    }
  }

  async followUp(
    result: AgentResult,
    agent: AgentHandle,
    role: AgentRole = "tdd",
    maxFollowUps = 3,
  ): Promise<AgentResult> {
    let current = result;
    let followUps = 0;

    while (current.needsInput && !this.config.auto && followUps < maxFollowUps) {
      const answer = await this.gate.askUser("Your response (or Enter to skip): ");

      if (!answer.trim()) {
        current = await agent.send(
          "No preference — proceed with your best judgement. Make the decision yourself and continue implementing.",
        );
      } else {
        current = await agent.send(answer);
      }
      await this.checkCredit(current, agent, role);
      followUps++;
    }

    return current;
  }

  async withRetry(
    fn: () => Promise<AgentResult>,
    agent: AgentHandle,
    role: AgentRole,
    label: string,
    maxRetries = 2,
    delayMs = this.retryDelayMs,
  ): Promise<AgentResult> {
    let currentAgent = agent;
    let attempt = 0;
    while (true) {
      const start = Date.now();
      const result = await fn();
      const elapsed = Date.now() - start;

      if (!currentAgent.alive) {
        // Intentional kill (hard interrupt, quit) — don't retry, let caller handle
        if (this.hardInterruptPending || this.quitRequested) {
          return result;
        }
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(`Agent died after ${maxRetries} respawn attempts (${label})`);
        }
        this.logOrch(`${role} agent died during ${label}; respawning ${attempt}/${maxRetries}...`);
        this.progressSink.setActivity(`${role} agent died, respawning ${attempt}/${maxRetries}...`);
        await this.respawnRole(role);
        currentAgent = this.agentForRole(role)!;
        await new Promise((r) => setTimeout(r, delayMs * attempt));
        continue;
      }
      const apiError = detectApiError(result, currentAgent.stderr);

      if (!apiError && elapsed < this.minAgentDurationMs) {
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(
            `Agent returned in ${elapsed}ms without doing work after ${maxRetries} retries (${label})`,
          );
        }
        this.progressSink.setActivity(
          `agent returned too quickly (${elapsed}ms), retrying ${attempt}/${maxRetries}...`,
        );
        await new Promise((r) => setTimeout(r, delayMs * attempt));
        continue;
      }

      if (!apiError) {
        return result;
      }

      if (!apiError.retryable) {
        if (await this.waitForUsageAvailability(apiError, role, label)) {
          continue;
        }
        await this.persistence.save(this.state);
        const decision = await this.gate.creditExhausted(
          label,
          `${apiError.kind}: ${result.resultText.slice(0, 200)}`,
        );
        if (decision.kind === "quit") {
          throw new CreditExhaustedError(
            `Terminal API error during ${label}: ${apiError.kind}`,
            result.assistantText.length > 0 ? "mid-response" : "rejected",
          );
        }
        // retry — operator chose to wait and retry
        continue;
      }

      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Max retries (${maxRetries}) exceeded for ${label}: ${apiError.kind}`);
      }

      this.progressSink.setActivity(`waiting to retry (${apiError.kind})...`);
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }

  private async waitForUsageAvailability(
    apiError: ApiError,
    role: AgentRole,
    label: string,
  ): Promise<boolean> {
    if (!this.config.auto || apiError.kind !== "credit-exhausted") {
      return false;
    }

    let attempt = 0;
    while (true) {
      const waitMs = Math.min(this.usageProbeDelayMs * 2 ** attempt, this.usageProbeMaxDelayMs);
      this.logOrch(
        `Auto mode blocked by usage limit during ${label}; probing again after ${waitMs}ms`,
      );
      this.progressSink.setActivity(
        `usage limited; probing ${role} again in ${Math.round(waitMs / 1000)}s`,
      );
      await this.persistence.save(this.state);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));

      const probe = this.spawnAgent(role, { cwd: this.config.cwd });
      try {
        const probeResult = await probe.send("Reply with exactly OK.");
        const probeError = detectApiError(probeResult, probe.stderr);
        if (probeError === null) {
          this.logOrch(`Usage probe succeeded for ${label}; retrying`);
          this.progressSink.setActivity(`usage available again; retrying ${label}...`);
          return true;
        }
      } finally {
        probe.kill();
      }

      attempt++;
    }
  }

  async checkCredit(
    result: AgentResult,
    agent: AgentHandle,
    role: AgentRole,
    label = "post-send",
  ): Promise<void> {
    const apiError = detectApiError(result, agent.stderr);
    if (!apiError || apiError.retryable) {
      return;
    }
    if (await this.waitForUsageAvailability(apiError, role, label)) {
      return;
    }
    await this.persistence.save(this.state);
    const decision = await this.gate.creditExhausted(
      label,
      `${apiError.kind}: ${result.resultText.slice(0, 200)}`,
    );
    if (decision.kind === "quit") {
      throw new CreditExhaustedError(
        `Terminal API error: ${apiError.kind}`,
        result.assistantText.length > 0 ? "mid-response" : "rejected",
      );
    }
    // operator chose retry — caller will re-send
  }

  async respawnTdd(): Promise<void> {
    if (this.tddAgent) {
      this.tddAgent.kill();
    }
    this.tddAgent = this.spawnAgent("tdd", { cwd: this.config.cwd });
    this.pipeToSink(this.tddAgent, "tdd");
    await this.tddAgent.sendQuiet(this.prompts.rulesReminder("tdd"));
    this.tddIsFirst = true;
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "tdd",
      session: this.currentSession("tdd"),
    });
    await this.persistence.save(this.state);
  }

  async respawnBoth(): Promise<void> {
    await this.respawnTierSensitiveAgents();
  }
}
