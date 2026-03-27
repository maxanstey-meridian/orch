import type { AgentProcess, AgentResult, AgentStyle } from "./agent/agent.js";
import type { Hud, WriteFn } from "./ui/hud.js";
import type { OrchestratorState } from "./state/state.js";
import {
  a,
  ts,
  BOT_TDD,
  BOT_REVIEW,
  BOT_VERIFY,
  BOT_PLAN,
  BOT_GAP,
  BOT_FINAL,
  printSliceIntro,
  printSliceSummary,
  type LogFn,
} from "./ui/display.js";
import { shouldReview, measureDiff } from "./cli/review-threshold.js";
import type { Group, Slice } from "./plan/plan-parser.js";
import { parseVerifyResult } from "./cli/verify.js";
import {
  buildCommitSweepPrompt,
  buildFinalPasses,
  buildGapPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildTddPrompt,
  withBrief,
} from "./plan/prompts.js";
import type { CreditSignal } from "./agent/credit-detection.js";
import { detectApiError } from "./agent/api-errors.js";
import { saveState } from "./state/state.js";
import { isCleanReview } from "./cli/review-check.js";
import { makeStreamer, type Streamer } from "./agent/streamer.js";
import { hasDirtyTree, captureRef, hasChanges } from "./git/git.js";
import {
  spawnAgent as spawnAgentFactory,
  spawnPlanAgentWithSkill,
  TDD_RULES_REMINDER,
  REVIEW_RULES_REMINDER,
} from "./agent/agent-factory.js";

export type OrchestratorConfig = {
  readonly cwd: string;
  readonly planPath: string;
  readonly planContent: string;
  readonly brief: string;
  readonly noInteraction: boolean;
  readonly auto: boolean;
  readonly reviewThreshold: number;
  readonly maxReviewCycles: number;
  readonly stateFile: string;
  readonly tddSkill: string;
  readonly reviewSkill: string;
  readonly verifySkill: string;
};

type PlanThenExecuteResult = {
  readonly tddResult: AgentResult;
  readonly skipped: boolean;
  readonly hardInterrupt?: string;
  readonly replan?: boolean;
};

export class CreditExhaustedError extends Error {
  readonly kind: CreditSignal["kind"];
  constructor(message: string, kind: CreditSignal["kind"]) {
    super(message);
    this.kind = kind;
  }
}

export class Orchestrator {
  state: OrchestratorState;
  tddAgent: AgentProcess;
  reviewAgent: AgentProcess;
  tddIsFirst = true;
  reviewIsFirst = true;

  interruptTarget: AgentProcess | null = null;
  sliceSkippable = false;
  sliceSkipFlag = false;
  hardInterruptPending: string | null = null;
  slicesCompleted = 0;
  activityShowing = false;
  retryDelayMs = 5_000;

  private readonly hudWriter: WriteFn;

  static async create(
    config: OrchestratorConfig,
    initialState: OrchestratorState,
    hud: Hud,
    log: LogFn,
    agents?: { tdd: AgentProcess; review: AgentProcess },
  ): Promise<Orchestrator> {
    const resuming = !agents && (initialState.tddSessionId || initialState.reviewSessionId);
    const tddAgent =
      agents?.tdd ??
      spawnAgentFactory(BOT_TDD, config.tddSkill, initialState.tddSessionId, config.cwd);
    const reviewAgent =
      agents?.review ??
      spawnAgentFactory(BOT_REVIEW, config.reviewSkill, initialState.reviewSessionId, config.cwd);
    if (!resuming) {
      await Promise.all([
        tddAgent.sendQuiet(TDD_RULES_REMINDER),
        reviewAgent.sendQuiet(REVIEW_RULES_REMINDER),
      ]);
    }
    return new Orchestrator(config, initialState, hud, log, tddAgent, reviewAgent);
  }

  private constructor(
    readonly config: OrchestratorConfig,
    initialState: OrchestratorState,
    readonly hud: Hud,
    readonly log: LogFn,
    tddAgent: AgentProcess,
    reviewAgent: AgentProcess,
  ) {
    this.state = initialState;
    this.tddAgent = tddAgent;
    this.reviewAgent = reviewAgent;
    this.hudWriter = hud.createWriter();
  }

  streamer(style: AgentStyle): Streamer {
    const base = makeStreamer(style, this.hudWriter);
    const wrapped = (text: string) => {
      if (this.activityShowing) {
        this.activityShowing = false;
        this.hud.setActivity("thinking...");
      }
      base(text);
    };
    wrapped.flush = base.flush;
    return wrapped;
  }

  setupKeyboardHandlers(): void {
    this.hud.onKey((key) => {
      if (key === "g" && this.interruptTarget) {
        this.hud.startPrompt("guide");
      } else if (key === "i" && this.interruptTarget) {
        this.hud.startPrompt("interrupt");
      } else if (key === "s" && this.sliceSkippable) {
        this.sliceSkipFlag = !this.sliceSkipFlag;
        this.hud.setSkipping(this.sliceSkipFlag);
      } else if (key === "q" || key === "\x03") {
        this.cleanup();
        process.exit(130);
      }
    });

    this.hud.onInterruptSubmit((text, mode) => {
      if (!this.interruptTarget) return;
      if (mode === "guide") {
        this.interruptTarget.inject(text);
      } else {
        this.hardInterruptPending = text;
        this.interruptTarget.kill();
      }
    });
  }

  async withInterrupt<T>(agent: AgentProcess, fn: () => Promise<T>): Promise<T> {
    this.interruptTarget = agent;
    try {
      return await fn();
    } finally {
      this.interruptTarget = null;
    }
  }

  async followUp(result: AgentResult, agent: AgentProcess, maxFollowUps = 3): Promise<AgentResult> {
    let current = result;
    let followUps = 0;

    while (current.needsInput && !this.config.noInteraction && followUps < maxFollowUps) {
      this.log("Bot is asking for input");
      const answer = await this.hud.askUser("Your response (or Enter to skip): ");

      const s = this.streamer(agent.style);
      if (!answer.trim()) {
        this.log("skipped — telling bot to proceed autonomously");
        current = await agent.send(
          "No preference — proceed with your best judgement. Make the decision yourself and continue implementing.",
          s,
        );
      } else {
        current = await agent.send(answer, s);
      }
      s.flush();
      followUps++;
    }

    return current;
  }

  async checkCredit(result: AgentResult, agent: AgentProcess): Promise<void> {
    const apiError = detectApiError(result, agent.stderr);
    if (!apiError || apiError.retryable) return;
    this.log(`Terminal API error detected: ${apiError.kind}`);
    await saveState(this.config.stateFile, this.state);
    throw new CreditExhaustedError(
      `Terminal API error: ${apiError.kind}`,
      result.assistantText.length > 0 ? "mid-response" : "rejected",
    );
  }

  async withRetry(
    fn: () => Promise<AgentResult>,
    agent: AgentProcess,
    label: string,
    maxRetries = 2,
    delayMs = this.retryDelayMs,
  ): Promise<AgentResult> {
    let attempt = 0;
    while (true) {
      const result = await fn();
      const apiError = detectApiError(result, agent.stderr);

      if (!apiError) return result;

      if (!apiError.retryable) {
        await saveState(this.config.stateFile, this.state);
        throw new CreditExhaustedError(
          `Terminal API error during ${label}: ${apiError.kind}`,
          result.assistantText.length > 0 ? "mid-response" : "rejected",
        );
      }

      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Max retries (${maxRetries}) exceeded for ${label}: ${apiError.kind}`);
      }

      this.log(`${label}: ${apiError.kind} — retrying (${attempt}/${maxRetries})...`);
      this.hud.setActivity(`waiting to retry (${apiError.kind})...`);
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }

  async runSlice(
    slice: Slice,
    reviewBase: string,
    tddResult: AgentResult,
    verifyBaseSha: string,
  ): Promise<{ reviewBase: string; skipped: boolean }> {
    // Already-implemented detection
    const tddText = tddResult.assistantText ?? "";
    const headAfterTdd = await captureRef(this.config.cwd);
    if (this.isAlreadyImplemented(tddText, headAfterTdd, reviewBase)) {
      this.log(`${ts()} ⏩ Slice ${slice.number} already implemented — skipping verify/review`);
      this.state = {
        ...this.state,
        lastSliceImplemented: slice.number,
        lastCompletedSlice: slice.number,
      };
      await saveState(this.config.stateFile, this.state);
      this.slicesCompleted++;
      return { reviewBase, skipped: false };
    }

    // Verify gate
    const verified = await this.verify(slice, verifyBaseSha);
    if (!verified) {
      return { reviewBase, skipped: true };
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    this.state = {
      ...this.state,
      lastSliceImplemented: slice.number,
      reviewBaseSha: verifyBaseSha,
    };
    await saveState(this.config.stateFile, this.state);

    // Review-fix loop — gated on minimum diff threshold
    const diffStats = await measureDiff(this.config.cwd, reviewBase);
    if (!shouldReview(diffStats, this.config.reviewThreshold)) {
      this.log(`${ts()} Diff too small (${diffStats.total} lines) — deferring review`);
      this.state = { ...this.state, lastCompletedSlice: slice.number };
      await saveState(this.config.stateFile, this.state);
      this.slicesCompleted++;
      return { reviewBase, skipped: false };
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    await this.reviewFix(slice.content, reviewBase);
    const newReviewBase = await captureRef(this.config.cwd);

    if (this.sliceSkipFlag) {
      return { reviewBase: newReviewBase, skipped: true };
    }

    // Slice summary
    this.log(`${ts()} extracting slice summary...`);
    const summary = await this.tddAgent.sendQuiet(
      `Summarise what you just built for Slice ${slice.number} in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.`,
    );
    printSliceSummary(this.log, slice.number, summary);

    this.state = { ...this.state, lastCompletedSlice: slice.number };
    await saveState(this.config.stateFile, this.state);
    this.slicesCompleted++;
    this.hud.update({ activeAgent: undefined, activeAgentActivity: undefined });
    return { reviewBase: newReviewBase, skipped: false };
  }

  onToolUse(summary: string): void {
    this.activityShowing = true;
    this.hud.setActivity(summary);
  }

  async planThenExecute(sliceContent: string, forceAccept = false): Promise<PlanThenExecuteResult> {
    // ── Plan phase ──
    // Plan agent is always fresh — always needs the brief
    const planPrompt = withBrief(buildPlanPrompt(sliceContent), this.config.brief);
    // TDD agent is persistent — only needs brief on first message
    const tddBrief = this.tddIsFirst ? this.config.brief : "";
    const planAgent = spawnPlanAgentWithSkill(this.config.cwd);
    const ps = this.streamer(BOT_PLAN);
    const planResult = await this.withRetry(
      () => this.withInterrupt(planAgent, () =>
        planAgent.send(planPrompt, ps, (s) => this.onToolUse(s)),
      ),
      planAgent,
      "plan",
    );
    ps.flush();

    if (this.sliceSkipFlag) {
      planAgent.kill();
      return { tddResult: planResult, skipped: true };
    }

    const hardInterruptGuidance = this.hardInterruptPending;
    if (hardInterruptGuidance) {
      planAgent.kill();
      return { tddResult: planResult, skipped: false, hardInterrupt: hardInterruptGuidance };
    }

    planAgent.kill();

    const plan = planResult.planText ?? planResult.assistantText ?? "";

    // ── Confirmation gate ──
    let operatorGuidance = "";
    const noInteraction = forceAccept || this.config.noInteraction;
    if (!noInteraction) {
      const planLines = plan.split("\n");
      const MAX_PREVIEW = 30;
      const preview = planLines.slice(0, MAX_PREVIEW).join("\n");
      this.log(`${BOT_PLAN.badge} plan ready`);
      this.hud.update({ activeAgent: "TDD", activeAgentActivity: "executing plan..." });
      this.log(preview);
      if (planLines.length > MAX_PREVIEW) {
        this.log(`... (truncated, ${planLines.length} lines)`);
      }
      const answer = await this.hud.askUser("Accept plan? (y)es / (e)dit / (r)eplan: ");
      if (answer.startsWith("r")) {
        return { tddResult: planResult, skipped: false, replan: true };
      }
      if (answer.startsWith("e")) {
        operatorGuidance = await this.hud.askUser("Guidance for execution: ");
      }
    }

    // ── Execute phase ──
    this.log(`${BOT_TDD.badge} executing plan...`);
    const rawExecutePrompt = operatorGuidance
      ? `Operator guidance: ${operatorGuidance}\n\nExecute this plan:\n\n${plan}`
      : `Execute this plan:\n\n${plan}`;
    const executePrompt = withBrief(rawExecutePrompt, tddBrief);
    const es = this.streamer(BOT_TDD);
    const tddResult = await this.withRetry(
      () => this.withInterrupt(this.tddAgent, () =>
        this.tddAgent.send(executePrompt, es, (s) => this.onToolUse(s)),
      ),
      this.tddAgent,
      "tdd-execute",
    );
    es.flush();

    if (this.sliceSkipFlag) {
      return { tddResult, skipped: true };
    }

    const execInterrupt = this.hardInterruptPending;
    if (execInterrupt) {
      return { tddResult, skipped: false, hardInterrupt: execInterrupt };
    }

    return { tddResult, skipped: false };
  }

  async verify(slice: Slice, verifyBaseSha: string): Promise<boolean> {
    this.hud.update({ activeAgent: "VFY", activeAgentActivity: "verifying..." });
    this.log(`${ts()} ${BOT_VERIFY.badge} verifying slice ${slice.number}...`);

    const verifyAgent = await this.spawnVerifyAgent();
    const verifyPrompt = withBrief(
      `Verify the changes since commit ${verifyBaseSha}. Context: TDD implementation of Slice ${slice.number}.`,
      this.config.brief,
    );
    const onTool = (s: string) => this.onToolUse(s);
    let vs = this.streamer(BOT_VERIFY);
    const verifyResult = await this.withInterrupt(verifyAgent, () =>
      verifyAgent.send(verifyPrompt, vs, onTool),
    );
    vs.flush();
    let parsed = parseVerifyResult(verifyResult.assistantText ?? "");

    if (!parsed.passed) {
      this.log(`${ts()} ⚠ Verification failed — sending failures to TDD bot`);
      const failureContext =
        parsed.newFailures.length > 0
          ? parsed.newFailures.join("\n")
          : "Verification checks failed. Run the test/lint/typecheck pipeline and fix any failures.";
      const retryPrompt = `Verification found new failures after your implementation. Fix them:\n\n${failureContext}`;
      const rs = this.streamer(BOT_TDD);
      await this.withInterrupt(this.tddAgent, () => this.tddAgent.send(retryPrompt, rs, onTool));
      rs.flush();

      this.hud.update({ activeAgent: "VFY", activeAgentActivity: "re-verifying..." });
      this.log(`${ts()} ${BOT_VERIFY.badge} re-verifying...`);
      vs = this.streamer(BOT_VERIFY);
      const reVerifyResult = await this.withInterrupt(verifyAgent, () =>
        verifyAgent.send(
          `Re-verify changes since ${verifyBaseSha}. The TDD bot attempted fixes.`,
          vs,
          onTool,
        ),
      );
      vs.flush();
      parsed = parseVerifyResult(reVerifyResult.assistantText ?? "");

      if (!parsed.passed) {
        verifyAgent.kill();
        const failSummary = parsed.newFailures.join("\n") || "Checks still failing after retry.";
        this.log(`${ts()} ✗ Verification still failing after retry on Slice ${slice.number}`);
        const answer = await this.hud.askUser(
          `Slice ${slice.number} verification failed:\n${failSummary}\n\n(r)etry / (s)kip / s(t)op? `,
        );
        const choice = answer.trim().toLowerCase();
        if (choice === "t" || choice === "stop") {
          this.log(`${ts()} ✗ Operator stopped run at Slice ${slice.number}`);
          this.hud.teardown();
          process.exit(1);
        }
        if (choice === "s" || choice === "skip") {
          this.log(`${ts()} ⏭ Operator skipped Slice ${slice.number}`);
          return false;
        }
        this.log(`${ts()} ↻ Operator chose retry — continuing to review`);
        return true;
      }
    }

    verifyAgent.kill();
    return true;
  }

  isAlreadyImplemented(tddText: string, headSha: string, baseSha: string): boolean {
    const textMatch =
      /already (?:fully )?implemented/i.test(tddText) ||
      /already exist/i.test(tddText) ||
      /nothing (?:left )?to (?:do|implement|change)/i.test(tddText);
    return textMatch && headSha === baseSha;
  }

  async reviewFix(content: string, baseSha: string): Promise<void> {
    let reviewSha = baseSha;
    let priorFindings: string | undefined;

    for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
      if (this.sliceSkipFlag) break;

      this.log(`${ts()} ${BOT_REVIEW.badge} review cycle ${cycle}/${this.config.maxReviewCycles}`);

      if (!(await hasChanges(this.config.cwd, reviewSha))) {
        this.log(`${ts()} no diff — skipping review`);
        break;
      }

      this.hud.update({ activeAgent: "REV", activeAgentActivity: `reviewing (cycle ${cycle})...` });
      const reviewPrompt = this.reviewIsFirst
        ? withBrief(buildReviewPrompt(content, reviewSha, priorFindings), this.config.brief)
        : buildReviewPrompt(content, reviewSha, priorFindings);
      const onToolUse = (summary: string) => {
        this.activityShowing = true;
        this.hud.setActivity(summary);
      };
      let s = this.streamer(BOT_REVIEW);
      const reviewResult = await this.withInterrupt(this.reviewAgent, () =>
        this.reviewAgent.send(reviewPrompt, s, onToolUse),
      );
      s.flush();
      await this.checkCredit(reviewResult, this.reviewAgent);
      this.reviewIsFirst = false;
      const reviewText = reviewResult.assistantText;

      if (!reviewText || isCleanReview(reviewText)) {
        this.log(`${ts()} ${a.green}✓ Review clean — no findings.${a.reset}`);
        break;
      }

      priorFindings = reviewText;
      this.hud.update({ activeAgent: "TDD", activeAgentActivity: "fixing review feedback..." });
      this.log(`${ts()} ${BOT_TDD.badge} fixing review feedback...`);
      const preFixSha = await captureRef(this.config.cwd);
      const fixPrompt = buildTddPrompt(content, reviewText);
      s = this.streamer(BOT_TDD);
      const fixResult = await this.withInterrupt(this.tddAgent, () =>
        this.tddAgent.send(
          this.tddIsFirst ? withBrief(fixPrompt, this.config.brief) : fixPrompt,
          s,
          onToolUse,
        ),
      );
      s.flush();
      this.tddIsFirst = false;
      await this.checkCredit(fixResult, this.tddAgent);

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent);
      }

      if (!(await hasChanges(this.config.cwd, preFixSha))) {
        this.log(`${ts()} TDD bot made no changes — review cycle complete`);
        break;
      }

      // Advance to pre-fix SHA so next cycle reviews the fix delta, not an empty diff
      reviewSha = preFixSha;
    }
  }

  async commitSweep(groupName: string): Promise<void> {
    const dirty = await hasDirtyTree(this.config.cwd);
    if (!dirty) return;

    if (!this.tddAgent.alive) {
      this.log(`${ts()} ⚠ TDD agent not alive — skipping commit sweep`);
      return;
    }

    this.log(`${ts()} ${BOT_TDD.badge} uncommitted changes detected — asking TDD bot to commit`);
    const prompt = buildCommitSweepPrompt(groupName);
    const s = this.streamer(BOT_TDD);
    const onToolUse = (summary: string) => {
      this.activityShowing = true;
      this.hud.setActivity(summary);
    };
    const result = await this.withInterrupt(this.tddAgent, () =>
      this.tddAgent.send(prompt, s, onToolUse),
    );
    s.flush();
    await this.checkCredit(result, this.tddAgent);

    if (result.needsInput) {
      await this.followUp(result, this.tddAgent);
    }

    if (result.exitCode === 0) {
      this.log(`${ts()} ${a.green}✓ commit sweep complete${a.reset}`);
    } else {
      this.log(
        `${ts()} ${a.yellow}⚠ commit sweep agent failed (exit ${result.exitCode}) — uncommitted changes may remain${a.reset}`,
      );
    }
  }

  cleanup(): void {
    this.hud.teardown();
    this.tddAgent.kill();
    this.reviewAgent.kill();
  }

  async respawnBoth(): Promise<void> {
    this.tddAgent.kill();
    this.reviewAgent.kill();
    this.tddAgent = await this.spawnTddAgent();
    this.reviewAgent = await this.spawnReviewAgent();
    this.tddIsFirst = true;
    this.reviewIsFirst = true;
    this.state = {
      ...this.state,
      tddSessionId: this.tddAgent.sessionId,
      reviewSessionId: this.reviewAgent.sessionId,
    };
    await saveState(this.config.stateFile, this.state);
  }

  async run(groups: readonly Group[], startIdx: number): Promise<void> {
    const remaining = groups.slice(startIdx);
    const runBaseSha = await captureRef(this.config.cwd);

    for (let i = 0; i < remaining.length; i++) {
      const group = remaining[i];

      // Skip entire group if all its slices are already completed
      const allSlicesDone =
        this.state.lastCompletedSlice !== undefined &&
        group.slices.every((s) => s.number <= this.state.lastCompletedSlice!);
      if (allSlicesDone) {
        this.slicesCompleted += group.slices.length;
        this.hud.update({ completedSlices: this.slicesCompleted });
        continue;
      }

      // ── Slice loop ──
      this.hud.update({
        groupName: group.name,
        groupSliceCount: group.slices.length,
        groupCompleted: 0,
      });
      this.state = {
        ...this.state,
        tddSessionId: this.tddAgent.sessionId,
        reviewSessionId: this.reviewAgent.sessionId,
      };
      await saveState(this.config.stateFile, this.state);
      const groupBaseSha = await captureRef(this.config.cwd);
      let reviewBase = groupBaseSha;
      let groupCompleted = 0;
      for (const slice of group.slices) {
        if (
          this.state.lastCompletedSlice !== undefined &&
          slice.number <= this.state.lastCompletedSlice
        ) {
          this.slicesCompleted++;
          groupCompleted++;
          this.hud.update({ completedSlices: this.slicesCompleted, groupCompleted });
          continue;
        }

        this.hud.update({
          currentSlice: { number: slice.number },
          completedSlices: this.slicesCompleted,
        });
        printSliceIntro(this.log, slice);

        const verifyBaseSha = await captureRef(this.config.cwd);

        // Plan-then-execute with replan loop
        const MAX_REPLANS = 2;
        let replanAttempts = 0;
        let pteResult: PlanThenExecuteResult;
        do {
          pteResult = await this.planThenExecute(slice.content);
          replanAttempts++;
        } while (pteResult.replan && replanAttempts < MAX_REPLANS);

        // After max replans, auto-accept
        if (pteResult.replan) {
          this.log(`${ts()} ${a.yellow}Max replans reached — auto-accepting plan${a.reset}`);
          pteResult = await this.planThenExecute(slice.content, true);
        }

        if (pteResult.skipped) {
          this.sliceSkipFlag = false;
          this.state = { ...this.state, lastCompletedSlice: slice.number };
          await saveState(this.config.stateFile, this.state);
          await this.respawnTdd();
          this.slicesCompleted++;
          groupCompleted++;
          this.hud.update({ completedSlices: this.slicesCompleted, groupCompleted });
          continue;
        }

        let tddResult = pteResult.tddResult;

        // Hard interrupt: agent was killed during plan or execute phase
        if (pteResult.hardInterrupt) {
          const guidance = pteResult.hardInterrupt;
          this.hardInterruptPending = null;
          this.log(`${ts()} ${a.yellow}⚡ Respawning TDD agent with guidance...${a.reset}`);
          await this.respawnTdd();
          const s = this.streamer(BOT_TDD);
          tddResult = await this.withInterrupt(this.tddAgent, () =>
            this.tddAgent.send(withBrief(guidance, this.config.brief), s, (sm) =>
              this.onToolUse(sm),
            ),
          );
          s.flush();
        }

        this.tddIsFirst = false;

        await this.checkCredit(tddResult, this.tddAgent);
        if (tddResult.needsInput) {
          await this.followUp(tddResult, this.tddAgent);
        }

        // Commit sweep — ensure TDD bot's work is committed
        await this.commitSweep(`Slice ${slice.number}`);

        // Post-TDD pipeline: verify → review → summary
        const sliceResult = await this.runSlice(slice, reviewBase, tddResult, verifyBaseSha);
        reviewBase = sliceResult.reviewBase;
        if (!sliceResult.skipped) {
          groupCompleted++;
          this.hud.update({ completedSlices: this.slicesCompleted, groupCompleted });
        }
      }

      // Gap analysis
      await this.gapAnalysis(group, groupBaseSha);

      // Commit sweep — catch uncommitted changes before marking group done
      await this.commitSweep(group.name);

      // Mark group complete
      this.state = { ...this.state, lastCompletedGroup: group.name };
      await saveState(this.config.stateFile, this.state);

      // Inter-group transition
      if (i < remaining.length - 1) {
        await this.respawnBoth();

        if (!this.config.auto && !this.config.noInteraction) {
          const next = remaining[i + 1];
          const nextLabel = `${next.name} (${next.slices.map((s) => `Slice ${s.number}`).join(", ")})`;
          this.log(`${ts()} ${a.green}✓ Group "${group.name}" complete${a.reset}`);
          const answer = await this.hud.askUser(`Group done. Run ${nextLabel} next? (Y/n) `);
          if (answer.toLowerCase() === "n") {
            this.log(`Stopped. Resume with --group "${next.name}"`);
            return;
          }
        }
      }
    }

    // Final review passes
    await this.finalPasses(runBaseSha);
  }

  async gapAnalysis(group: Group, groupBaseSha: string): Promise<void> {
    if (this.sliceSkipFlag) {
      this.sliceSkipFlag = false;
      return;
    }

    if (!(await hasChanges(this.config.cwd, groupBaseSha))) {
      return;
    }

    this.log(`${ts()} ${BOT_GAP.badge} scanning for coverage gaps across group...`);
    const groupContent = group.slices.map((s) => s.content).join("\n\n---\n\n");
    const gapAgent = spawnAgentFactory(BOT_GAP, undefined, undefined, this.config.cwd);
    const gapPrompt = withBrief(buildGapPrompt(groupContent, groupBaseSha), this.config.brief);
    const onTool = (s: string) => this.onToolUse(s);
    const gs = this.streamer(BOT_GAP);
    this.hud.update({ activeAgent: "GAP", activeAgentActivity: "scanning for gaps..." });
    const gapResult = await this.withInterrupt(gapAgent, () =>
      gapAgent.send(gapPrompt, gs, onTool),
    );
    gs.flush();
    await this.checkCredit(gapResult, gapAgent);

    if (this.sliceSkipFlag) {
      this.sliceSkipFlag = false;
      gapAgent.kill();
      return;
    }
    if (this.hardInterruptPending) {
      this.hardInterruptPending = null;
      this.log(`${ts()} ${a.yellow}⚠ Gap analysis interrupted — skipping${a.reset}`);
      gapAgent.kill();
      return;
    }

    const gapText = gapResult.assistantText ?? "";

    if (gapResult.exitCode !== 0) {
      this.log(
        `${ts()} ${a.yellow}⚠ Gap analysis agent failed (exit ${gapResult.exitCode}) — skipping${a.reset}`,
      );
      gapAgent.kill();
      return;
    }

    if (gapText.includes("NO_GAPS_FOUND")) {
      this.log(`${ts()} ${a.green}✓ No coverage gaps found${a.reset}`);
      gapAgent.kill();
      return;
    }

    this.log(`${ts()} ${BOT_GAP.badge} gaps found — sending to TDD bot`);
    const gapBaseSha = await captureRef(this.config.cwd);
    const gapFixPrompt = buildTddPrompt(
      groupContent,
      `A gap analysis found missing test coverage. Add the missing tests.\n\n## Gaps Found\n${gapText}\n\nAdd tests for each gap. Do NOT refactor or change existing code — only add tests.`,
    );
    const ts2 = this.streamer(BOT_TDD);
    const fixPrompt = this.tddIsFirst ? withBrief(gapFixPrompt, this.config.brief) : gapFixPrompt;
    const fixResult = await this.withInterrupt(this.tddAgent, () =>
      this.tddAgent.send(fixPrompt, ts2, onTool),
    );
    ts2.flush();
    this.tddIsFirst = false;
    await this.checkCredit(fixResult, this.tddAgent);

    if (this.sliceSkipFlag) {
      this.sliceSkipFlag = false;
      gapAgent.kill();
      return;
    }
    if (this.hardInterruptPending) {
      this.hardInterruptPending = null;
      this.log(`${ts()} ${a.yellow}⚠ Gap analysis interrupted — skipping${a.reset}`);
      gapAgent.kill();
      return;
    }

    if (fixResult.needsInput) {
      await this.followUp(fixResult, this.tddAgent);
    }

    if (await hasChanges(this.config.cwd, gapBaseSha)) {
      await this.reviewFix(groupContent, gapBaseSha);
      this.hud.update({ activeAgent: undefined, activeAgentActivity: undefined });
      this.log(`${ts()} ${a.green}✓ Gap tests added and reviewed${a.reset}`);
    }

    gapAgent.kill();
  }

  async finalPasses(runBaseSha: string): Promise<void> {
    if (!(await hasChanges(this.config.cwd, runBaseSha))) {
      return;
    }

    const passes = buildFinalPasses(runBaseSha, this.config.planContent);
    const onTool = (s: string) => this.onToolUse(s);

    for (const pass of passes) {
      this.log(`${ts()} ${BOT_FINAL.badge} ${pass.name}...`);

      const finalAgent = spawnAgentFactory(BOT_FINAL, undefined, undefined, this.config.cwd);
      const finalPrompt = withBrief(pass.prompt, this.config.brief);
      const fs = this.streamer(BOT_FINAL);
      const finalResult = await this.withInterrupt(finalAgent, () =>
        finalAgent.send(finalPrompt, fs, onTool),
      );
      fs.flush();
      await this.checkCredit(finalResult, finalAgent);
      finalAgent.kill();

      if (finalResult.exitCode !== 0) {
        this.log(`${ts()} ${pass.name}: agent failed — skipping`);
        continue;
      }

      const findings = finalResult.assistantText;
      if (!findings || findings.includes("NO_ISSUES_FOUND")) {
        this.log(`${ts()} ${a.green}✓ ${pass.name}: clean${a.reset}`);
        continue;
      }

      // Fix cycle
      this.log(`${ts()} ${BOT_TDD.badge} fixing ${pass.name} findings...`);
      const preFixSha = await captureRef(this.config.cwd);
      const fixPrompt = buildTddPrompt(
        this.config.planContent,
        `A final "${pass.name}" review found issues. Address them.\n\n## Findings\n${findings}`,
      );
      const ts2 = this.streamer(BOT_TDD);
      const actualFixPrompt = this.tddIsFirst ? withBrief(fixPrompt, this.config.brief) : fixPrompt;
      const fixResult = await this.withInterrupt(this.tddAgent, () =>
        this.tddAgent.send(actualFixPrompt, ts2, onTool),
      );
      ts2.flush();
      this.tddIsFirst = false;
      await this.checkCredit(fixResult, this.tddAgent);

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent);
      }

      if (await hasChanges(this.config.cwd, preFixSha)) {
        await this.reviewFix(this.config.planContent, preFixSha);
        this.hud.update({ activeAgent: undefined, activeAgentActivity: undefined });
        this.log(`${ts()} ${a.green}✓ ${pass.name}: resolved${a.reset}`);
      }
    }
  }

  private async spawnTddAgent(): Promise<AgentProcess> {
    const agent = spawnAgentFactory(BOT_TDD, this.config.tddSkill, undefined, this.config.cwd);
    await agent.sendQuiet(TDD_RULES_REMINDER);
    return agent;
  }

  private async spawnReviewAgent(): Promise<AgentProcess> {
    const agent = spawnAgentFactory(BOT_REVIEW, this.config.reviewSkill, undefined, this.config.cwd);
    await agent.sendQuiet(REVIEW_RULES_REMINDER);
    return agent;
  }

  private async spawnVerifyAgent(): Promise<AgentProcess> {
    return spawnAgentFactory(BOT_VERIFY, this.config.verifySkill, undefined, this.config.cwd);
  }

  async respawnTdd(): Promise<void> {
    this.tddAgent.kill();
    this.tddAgent = await this.spawnTddAgent();
    this.tddIsFirst = true;
    this.state = { ...this.state, tddSessionId: this.tddAgent.sessionId };
    await saveState(this.config.stateFile, this.state);
  }
}
