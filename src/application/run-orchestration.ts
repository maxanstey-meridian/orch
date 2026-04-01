import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import { detectApiError } from "#domain/api-errors.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { CreditExhaustedError, IncompleteRunError } from "#domain/errors.js";
import type { Phase } from "#domain/phase.js";
import type { Group } from "#domain/plan.js";
import type { Slice } from "#domain/plan.js";
import { isCleanReview } from "#domain/review-check.js";
import { shouldReview } from "#domain/review.js";
import type { OrchestratorState, PersistedPhase, StateEvent } from "#domain/state.js";
import { advanceState } from "#domain/state.js";
import { isAlreadyImplemented } from "#domain/transition.js";
import { transition } from "#domain/transition.js";
import type { TriageResult } from "#domain/triage.js";
import { FULL_TRIAGE } from "#domain/triage.js";
import { parseVerifyResult } from "#domain/verify.js";
import { buildTriagePrompt, parseTriageResult } from "#infrastructure/diff-triage.js";
import type { AgentSpawner, AgentHandle } from "./ports/agent-spawner.port.js";
import type { GitOps } from "./ports/git-ops.port.js";
import type { OperatorGate } from "./ports/operator-gate.port.js";
import type { ProgressSink } from "./ports/progress-sink.port.js";
import type { PromptBuilder } from "./ports/prompt-builder.port.js";
import type { StatePersistence } from "./ports/state-persistence.port.js";

export type PlanThenExecuteResult = {
  readonly tddResult: AgentResult;
  readonly skipped: boolean;
  readonly hardInterrupt?: string;
  readonly replan?: boolean;
  readonly planText?: string;
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
  ] as const;

  state: OrchestratorState = {};
  phase: Phase = { kind: "Idle" };
  tddAgent: AgentHandle | null = null;
  reviewAgent: AgentHandle | null = null;
  verifyAgent: AgentHandle | null = null;
  retryDelayMs = 5_000;
  tddIsFirst = true;
  reviewIsFirst = true;
  sliceSkipFlag = false;
  quitRequested = false;
  hardInterruptPending: string | null = null;
  slicesCompleted = 0;

  constructor(
    private readonly agents: AgentSpawner,
    private readonly persistence: StatePersistence,
    private readonly gate: OperatorGate,
    private readonly git: GitOps,
    private readonly prompts: PromptBuilder,
    private readonly config: OrchestratorConfig,
    private readonly progressSink: ProgressSink,
  ) {}

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
    agent.pipe(streamer, (summary) => this.progressSink.setActivity(summary));
  }

  private async persistStateEvent(event: StateEvent): Promise<void> {
    this.state = advanceState(this.state, event);
    await this.persistence.save(this.state);
  }

  private async enterPhase(phase: PersistedPhase, sliceNumber: number): Promise<void> {
    await this.persistStateEvent({ kind: "phaseEntered", phase, sliceNumber });
  }

  private async clearPersistedPhase(): Promise<void> {
    if (this.state.currentPhase === undefined) {
      return;
    }
    this.state = { ...this.state, currentPhase: undefined };
    await this.persistence.save(this.state);
  }

  private currentSliceNumber(defaultSliceNumber = 0): number {
    return this.state.currentSlice ?? this.state.lastCompletedSlice ?? defaultSliceNumber;
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
    this.progressSink.teardown();
  }

  async execute(
    groups: readonly Group[],
    opts?: {
      onReady?: (info: { tddSessionId: string; reviewSessionId: string }) => void;
    },
  ): Promise<void> {
    if (groups.length === 0) {
      return;
    }

    this.state = await this.persistence.load();

    // Spawn initial agents
    this.tddAgent = this.agents.spawn("tdd", {
      resumeSessionId: this.state.tddSessionId,
      cwd: this.config.cwd,
    });
    this.reviewAgent = this.agents.spawn("review", {
      resumeSessionId: this.state.reviewSessionId,
      cwd: this.config.cwd,
    });
    this.pipeToSink(this.tddAgent, "tdd");
    this.pipeToSink(this.reviewAgent, "review");

    // Send rules reminders (skip if resuming)
    const reminders: Promise<string>[] = [];
    if (!this.state.tddSessionId) {
      reminders.push(this.tddAgent.sendQuiet(this.prompts.rulesReminder("tdd")));
    }
    if (!this.state.reviewSessionId) {
      reminders.push(this.reviewAgent.sendQuiet(this.prompts.rulesReminder("review")));
    }
    await Promise.all(reminders);

    if (this.state.tddSessionId) {
      this.tddIsFirst = false;
    }
    if (this.state.reviewSessionId) {
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

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];

      // Skip entire group if all its slices are already completed
      const allSlicesDone =
        this.state.lastCompletedSlice !== undefined &&
        group.slices.every((s) => s.number <= this.state.lastCompletedSlice!);
      if (allSlicesDone) {
        this.slicesCompleted += group.slices.length;
        this.progressSink.updateProgress({ completedSlices: this.slicesCompleted });
        continue;
      }

      // ── Slice loop ──
      this.progressSink.updateProgress({
        groupName: group.name,
        groupSliceCount: group.slices.length,
        groupCompleted: 0,
      });
      this.state = advanceState(this.state, {
        kind: "agentSpawned",
        role: "tdd",
        sessionId: this.tddAgent.sessionId,
      });
      this.state = advanceState(this.state, {
        kind: "agentSpawned",
        role: "review",
        sessionId: this.reviewAgent!.sessionId,
      });
      await this.persistence.save(this.state);
      const groupBaseSha = await this.git.captureRef();
      let reviewBase = groupBaseSha;
      let groupCompleted = 0;

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

        const verifyBaseSha = await this.git.captureRef();

        // Plan-then-execute with replan loop
        this.phase = transition(this.phase, { kind: "StartPlanning", sliceNumber: slice.number });
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

        // Triage: classify the diff to decide which pipeline phases to run
        const triage = await this.triageDiff(verifyBaseSha);

        // Completeness check
        if (triage.runCompleteness) {
          await this.completenessCheck(slice, verifyBaseSha);
        }

        // Post-TDD pipeline: verify → review → summary
        const sliceResult = await this.runSlice(
          slice,
          reviewBase,
          tddResult,
          verifyBaseSha,
          triage,
        );
        reviewBase = sliceResult.reviewBase;
        this.phase = { kind: "Idle" };

        if (sliceResult.skipped) {
          this.failIncompleteSlice(slice, "verification or review did not complete");
        }

        if (!sliceResult.skipped) {
          groupCompleted++;
          this.progressSink.updateProgress({
            completedSlices: this.slicesCompleted,
            groupCompleted,
          });
        }
      }

      // Gap analysis
      await this.gapAnalysis(group, groupBaseSha);

      // Commit sweep
      await this.commitSweep(group.name);

      // Mark group complete
      this.state = advanceState(this.state, { kind: "groupDone", groupName: group.name });
      await this.persistence.save(this.state);

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
  }

  async planThenExecute(
    sliceContent: string,
    sliceNumber: number,
    forceAccept = false,
  ): Promise<PlanThenExecuteResult> {
    if (this.config.planDisabled) {
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
        "tdd-direct",
      );
      this.tddIsFirst = false;
      this.phase = transition(this.phase, { kind: "ExecutionDone" });
      return { tddResult, skipped: false };
    }

    // ── Plan phase ──
    const planPrompt = this.prompts.plan(sliceContent, sliceNumber);
    const planAgent = this.agents.spawn("plan", { cwd: this.config.cwd });
    this.pipeToSink(planAgent, "plan");
    this.progressSink.logBadge("plan", "planning...");
    await this.enterPhase("plan", sliceNumber);
    const planResult = await this.withRetry(() => planAgent.send(planPrompt), planAgent, "plan");

    const plan = planResult.planText ?? planResult.assistantText ?? "";

    if (this.sliceSkipFlag) {
      planAgent.kill();
      this.phase = { kind: "Idle" };
      return { tddResult: planResult, skipped: true, planText: plan };
    }

    const hardInterruptGuidance = this.hardInterruptPending;
    if (hardInterruptGuidance) {
      planAgent.kill();
      this.phase = { kind: "Idle" };
      return {
        tddResult: planResult,
        skipped: false,
        hardInterrupt: hardInterruptGuidance,
        planText: plan,
      };
    }

    planAgent.kill();

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

  async runSlice(
    slice: Slice,
    reviewBase: string,
    tddResult: AgentResult,
    verifyBaseSha: string,
    triage: TriageResult = FULL_TRIAGE,
  ): Promise<{ reviewBase: string; skipped: boolean }> {
    const tddText = tddResult.assistantText ?? "";
    const headAfterTdd = await this.git.captureRef();

    if (isAlreadyImplemented(tddText, headAfterTdd, reviewBase)) {
      this.phase = { kind: "Idle" };
      this.state = advanceState(this.state, { kind: "sliceDone", sliceNumber: slice.number });
      await this.persistence.save(this.state);
      this.slicesCompleted++;
      return { reviewBase, skipped: false };
    }

    // Verify gate
    if (this.config.verifySkill === null || !triage.runVerify) {
      // verify disabled or triage skipped it
    } else {
      const verified = await this.verify(slice, verifyBaseSha);
      if (!verified) {
        return { reviewBase, skipped: true };
      }
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    this.phase = transition(this.phase, { kind: "VerifyPassed" });
    this.phase = transition(this.phase, { kind: "CompletenessOk" });

    this.state = advanceState(this.state, {
      kind: "sliceImplemented",
      sliceNumber: slice.number,
      reviewBaseSha: verifyBaseSha,
    });
    await this.persistence.save(this.state);

    // Review-fix loop — gated on minimum diff threshold
    const diffStats = await this.git.measureDiff(reviewBase);
    if (!shouldReview(diffStats, this.config.reviewThreshold)) {
      this.phase = transition(this.phase, { kind: "SliceComplete" });
      this.state = advanceState(this.state, { kind: "sliceDone", sliceNumber: slice.number });
      await this.persistence.save(this.state);
      this.slicesCompleted++;
      return { reviewBase, skipped: false };
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    if (this.config.reviewSkill !== null && triage.runReview) {
      await this.reviewFix(slice.content, reviewBase, slice.number);
    }
    const newReviewBase = await this.git.captureRef();

    if (this.sliceSkipFlag) {
      return { reviewBase: newReviewBase, skipped: true };
    }

    this.phase = transition(this.phase, { kind: "ReviewClean" });

    // Slice summary
    await this.tddAgent!.sendQuiet(
      `Summarise what you just built for Slice ${slice.number} in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.`,
    );

    this.state = advanceState(this.state, { kind: "sliceDone", sliceNumber: slice.number });
    await this.persistence.save(this.state);
    this.slicesCompleted++;
    this.progressSink.updateProgress({ activeAgent: undefined, activeAgentActivity: undefined });
    return { reviewBase: newReviewBase, skipped: false };
  }

  async reviewFix(content: string, baseSha: string, sliceNumber: number): Promise<void> {
    let reviewSha = baseSha;
    let priorFindings: string | undefined;

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

      const reviewPrompt = this.reviewIsFirst
        ? this.prompts.withBrief(this.prompts.review(content, reviewSha, priorFindings))
        : this.prompts.review(content, reviewSha, priorFindings);
      this.progressSink.logBadge("review", "reviewing...");
      await this.enterPhase("review", sliceNumber);
      const reviewResult = await this.withRetry(
        () => this.reviewAgent!.send(reviewPrompt),
        this.reviewAgent!,
        "review",
      );
      this.reviewIsFirst = false;
      const reviewText = reviewResult.assistantText;

      if (!reviewText || isCleanReview(reviewText)) {
        break;
      }

      this.phase = transition(this.phase, { kind: "ReviewIssues" });
      priorFindings = reviewText;
      const preFixSha = await this.git.captureRef();
      const fixPrompt = this.prompts.tdd(content, reviewText);
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", sliceNumber);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt),
        this.tddAgent!,
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

  async completenessCheck(slice: Slice, baseSha: string): Promise<void> {
    if (this.sliceSkipFlag) {
      return;
    }
    if (!(await this.git.hasChanges(baseSha))) {
      return;
    }

    const prompt = this.prompts.completeness(slice.content, baseSha, slice.number);
    const checkAgent = this.agents.spawn("completeness", { cwd: this.config.cwd });
    this.pipeToSink(checkAgent, "completeness");
    await this.enterPhase("verify", slice.number);
    const result = await this.withRetry(
      () => checkAgent.send(prompt),
      checkAgent,
      "completeness-check",
    );
    checkAgent.kill();

    const text = result.assistantText ?? "";
    const hasMissing = text.includes("❌") || text.includes("MISSING");
    if (text.includes("SLICE_COMPLETE") && !hasMissing) {
      return;
    }

    // Phase: Verifying → CompletenessCheck → Executing (issues found)
    this.phase = transition(this.phase, { kind: "VerifyPassed" });
    this.phase = transition(this.phase, { kind: "CompletenessIssues" });

    // Send findings to TDD for fixing
    const fixPrompt = this.prompts.tdd(
      slice.content,
      `A completeness check found that your implementation does not fully match the plan. Fix ALL issues below.\n\n## Completeness Findings\n${text}\n\nRules:\n- ❌ MISSING items are HARD FAILURES. The plan is the contract. Code that works but doesn't implement the plan's specified approach is NOT complete. You must implement what the plan says, not an alternative that passes tests.\n- ⚠️ DIVERGENT items mean your approach differs from the plan's intent. Change your implementation to match the plan, not the other way around.\n- If the plan says "use function X" or "call Y", your code must actually import and call X/Y. Passing tests are necessary but NOT sufficient — the plan's architectural requirements are equally binding.\n- Do NOT argue that your approach is equivalent. Do NOT skip items because tests pass without them. Implement what the plan says.`,
      slice.number,
    );
    this.progressSink.logBadge("tdd", "implementing...");
    await this.enterPhase("tdd", slice.number);
    const fixResult = await this.withRetry(
      () => this.tddAgent!.send(this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt),
      this.tddAgent!,
      "completeness-fix",
    );
    this.tddIsFirst = false;

    if (fixResult.needsInput) {
      await this.followUp(fixResult, this.tddAgent!);
    }

    // Phase: Executing → Verifying (ready for runSlice)
    this.phase = transition(this.phase, { kind: "ExecutionDone" });

    await this.commitSweep(`Slice ${slice.number} completeness fix`);
  }

  async verify(slice: Slice, verifyBaseSha: string): Promise<boolean> {
    this.progressSink.updateProgress({ activeAgent: "VFY", activeAgentActivity: "verifying..." });

    if (!this.verifyAgent) {
      this.verifyAgent = this.agents.spawn("verify", { cwd: this.config.cwd });
      this.pipeToSink(this.verifyAgent, "verify");
    }

    const verifyPrompt = this.prompts.withBrief(
      `Verify the changes since commit ${verifyBaseSha}. Context: TDD implementation of Slice ${slice.number}.`,
    );
    this.progressSink.logBadge("verify", "verifying...");
    await this.enterPhase("verify", slice.number);
    const verifyResult = await this.withRetry(
      () => this.verifyAgent!.send(verifyPrompt),
      this.verifyAgent,
      "verify",
    );
    let parsed = parseVerifyResult(verifyResult.assistantText ?? "");

    while (!parsed.passed) {
      this.phase = transition(this.phase, { kind: "VerifyFailed" });

      const failureContext =
        parsed.newFailures.length > 0
          ? parsed.newFailures.join("\n")
          : "Verification checks failed. Run the test/lint/typecheck pipeline and fix any failures.";

      // Send findings to TDD for fixing
      const retryPrompt = `Verification found issues after your implementation. Fix them:\n\n${failureContext}`;
      const preFixSha = await this.git.captureRef();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", slice.number);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(retryPrompt),
        this.tddAgent!,
        "verify-fix",
      );
      await this.checkCredit(fixResult, this.tddAgent!);

      this.phase = transition(this.phase, { kind: "ExecutionDone" });

      // If TDD made no changes, surface to operator — don't re-verify endlessly
      if (!(await this.git.hasChanges(preFixSha))) {
        const failSummary =
          parsed.newFailures.join("\n") || "Verification issues remain but TDD made no changes.";
        const decision = await this.gate.verifyFailed(slice.number, failSummary);

        if (decision.kind === "stop") {
          throw new IncompleteRunError(
            `Slice ${slice.number} verification failed and execution stopped`,
          );
        }
        if (decision.kind === "skip") {
          return false;
        }
        continue;
      }

      // Re-verify — tell the verifier what TDD fixed
      const fixSummary = fixResult.assistantText?.slice(0, 500) ?? "TDD attempted fixes.";
      this.progressSink.logBadge("verify", "verifying...");
      await this.enterPhase("verify", slice.number);
      const reVerifyResult = await this.withRetry(
        () =>
          this.verifyAgent!.send(
            `Re-verify changes since ${verifyBaseSha}. The TDD bot made the following fixes:\n\n${fixSummary}\n\nCheck if the original issues are resolved.`,
          ),
        this.verifyAgent!,
        "re-verify",
      );
      parsed = parseVerifyResult(reVerifyResult.assistantText ?? "");

      if (!parsed.passed) {
        const failSummary =
          parsed.newFailures.join("\n") || "Checks still failing after fix attempt.";
        const decision = await this.gate.verifyFailed(slice.number, failSummary);

        if (decision.kind === "stop") {
          throw new IncompleteRunError(
            `Slice ${slice.number} verification failed and execution stopped`,
          );
        }
        if (decision.kind === "skip") {
          return false;
        }
        continue;
      }
    }

    return true;
  }

  async finalPasses(runBaseSha: string): Promise<void> {
    if (!(await this.git.hasChanges(runBaseSha))) {
      return;
    }

    this.phase = transition(this.phase, { kind: "StartFinalPasses" });

    const passes = this.prompts.finalPasses(runBaseSha);

    for (const pass of passes) {
      const finalAgent = this.agents.spawn("final", { cwd: this.config.cwd });
      this.pipeToSink(finalAgent, "final");
      const finalPrompt = this.prompts.withBrief(pass.prompt);
      this.progressSink.logBadge("final", "finalising...");
      await this.enterPhase("final", this.currentSliceNumber());
      const finalResult = await this.withRetry(
        () => finalAgent.send(finalPrompt),
        finalAgent,
        "final-pass",
      );
      finalAgent.kill();

      if (finalResult.exitCode !== 0) {
        continue;
      }
      const findings = finalResult.assistantText ?? "";
      if (!findings || findings.includes("NO_ISSUES_FOUND")) {
        continue;
      }

      // Fix cycle
      const fixPrompt = this.prompts.tdd(
        this.config.planContent,
        `A final "${pass.name}" review found issues. Address them.\n\n## Findings\n${findings}`,
      );
      const actualFixPrompt = this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt;
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", this.currentSliceNumber());
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(actualFixPrompt),
        this.tddAgent!,
        "final-fix",
      );
      this.tddIsFirst = false;
      await this.checkCredit(fixResult, this.tddAgent!);

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent!);
      }

      await this.commitSweep(`${pass.name} final fix`);
    }

    this.phase = transition(this.phase, { kind: "AllPassesDone" });
    await this.clearPersistedPhase();
  }

  async gapAnalysis(group: Group, groupBaseSha: string): Promise<void> {
    if (!(await this.git.hasChanges(groupBaseSha))) {
      return;
    }
    if (this.config.gapDisabled) {
      return;
    }

    this.phase = transition(this.phase, { kind: "StartGap", groupName: group.name });

    const groupContent = group.slices.map((s) => s.content).join("\n\n---\n\n");
    const gapAgent = this.agents.spawn("gap", { cwd: this.config.cwd });
    this.pipeToSink(gapAgent, "gap");
    const gapPrompt = this.prompts.withBrief(this.prompts.gap(groupContent, groupBaseSha));
    this.progressSink.logBadge("gap", "filling gaps...");
    await this.enterPhase(
      "gap",
      this.currentSliceNumber(group.slices[group.slices.length - 1]?.number ?? 0),
    );
    const gapResult = await this.withRetry(() => gapAgent.send(gapPrompt), gapAgent, "gap");

    const gapText = gapResult.assistantText ?? "";

    if (gapResult.exitCode !== 0 || gapText.includes("NO_GAPS_FOUND")) {
      gapAgent.kill();
      this.phase = transition(this.phase, { kind: "GapDone" });
      return;
    }

    // Fix cycle
    const fixPrompt = this.prompts.tdd(
      groupContent,
      `A gap analysis found missing test coverage. Add the missing tests.\n\n## Gaps Found\n${gapText}\n\nAdd tests for each gap. Do NOT refactor or change existing code — only add tests.`,
    );
    const actualFixPrompt = this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt;
    this.progressSink.logBadge("tdd", "implementing...");
    await this.enterPhase(
      "tdd",
      this.currentSliceNumber(group.slices[group.slices.length - 1]?.number ?? 0),
    );
    const fixResult = await this.withRetry(
      () => this.tddAgent!.send(actualFixPrompt),
      this.tddAgent!,
      "gap-fix",
    );
    this.tddIsFirst = false;
    await this.checkCredit(fixResult, this.tddAgent!);

    if (fixResult.needsInput) {
      await this.followUp(fixResult, this.tddAgent!);
    }

    await this.commitSweep(`${group.name} gap fixes`);

    gapAgent.kill();
    this.phase = transition(this.phase, { kind: "GapDone" });
  }

  async triageDiff(baseSha: string): Promise<TriageResult> {
    const diff = await this.git.getDiff(baseSha);
    if (!diff) {
      return FULL_TRIAGE;
    }
    try {
      const agent = this.agents.spawn("triage", { cwd: this.config.cwd });
      const prompt = buildTriagePrompt(diff);
      const result = await agent.send(prompt);
      agent.kill();
      const triage = parseTriageResult(result.assistantText ?? "");
      this.progressSink.logBadge("triage", triage.reason);
      return triage;
    } catch {
      return FULL_TRIAGE;
    }
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
      "commit-sweep",
    );

    if (result.needsInput) {
      await this.followUp(result, this.tddAgent);
    }
  }

  async followUp(result: AgentResult, agent: AgentHandle, maxFollowUps = 3): Promise<AgentResult> {
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
      await this.checkCredit(current, agent);
      followUps++;
    }

    return current;
  }

  async withRetry(
    fn: () => Promise<AgentResult>,
    agent: AgentHandle,
    label: string,
    maxRetries = 2,
    delayMs = this.retryDelayMs,
  ): Promise<AgentResult> {
    let attempt = 0;
    while (true) {
      const result = await fn();
      if (!agent.alive) {
        return result;
      }
      const apiError = detectApiError(result, agent.stderr);
      if (!apiError) {
        return result;
      }

      if (!apiError.retryable) {
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

  async checkCredit(result: AgentResult, agent: AgentHandle, label = "post-send"): Promise<void> {
    const apiError = detectApiError(result, agent.stderr);
    if (!apiError || apiError.retryable) {
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
    this.tddAgent = this.agents.spawn("tdd", { cwd: this.config.cwd });
    this.pipeToSink(this.tddAgent, "tdd");
    await this.tddAgent.sendQuiet(this.prompts.rulesReminder("tdd"));
    this.tddIsFirst = true;
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "tdd",
      sessionId: this.tddAgent.sessionId,
    });
    await this.persistence.save(this.state);
  }

  async respawnBoth(): Promise<void> {
    if (this.tddAgent) {
      this.tddAgent.kill();
    }
    if (this.reviewAgent) {
      this.reviewAgent.kill();
    }
    if (this.verifyAgent) {
      this.verifyAgent.kill();
      this.verifyAgent = null;
    }
    this.tddAgent = this.agents.spawn("tdd", { cwd: this.config.cwd });
    this.reviewAgent = this.agents.spawn("review", { cwd: this.config.cwd });
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
      sessionId: this.tddAgent.sessionId,
    });
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "review",
      sessionId: this.reviewAgent.sessionId,
    });
    await this.persistence.save(this.state);
  }
}
