import type { AgentProcess, AgentResult, AgentStyle } from "./agent.js";
import type { Hud, WriteFn } from "./hud.js";
import type { OrchestratorState } from "./state.js";
import { a, ts, BOT_TDD, BOT_REVIEW, BOT_VERIFY, printSliceSummary } from "./display.js";
import { shouldReview, type DiffStats } from "./review-threshold.js";
import type { Slice } from "./plan-parser.js";
import { parseVerifyResult } from "./verify.js";
import type { LogFn } from "./display.js";
import { buildCommitSweepPrompt, buildReviewPrompt, buildTddPrompt, withBrief } from "./prompts.js";
import type { CreditSignal } from "./credit-detection.js";
import { makeStreamer, type Streamer } from "./streamer.js";

export type GitPort = {
  readonly hasDirtyTree: (cwd: string) => Promise<boolean>;
  readonly captureRef: (cwd: string) => Promise<string>;
  readonly hasChanges: (cwd: string, since: string) => Promise<boolean>;
};

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

  private readonly hudWriter: WriteFn;

  constructor(
    readonly config: OrchestratorConfig,
    initialState: OrchestratorState,
    readonly hud: Hud,
    readonly log: LogFn,
    tddAgent: AgentProcess,
    reviewAgent: AgentProcess,
    private readonly spawnTdd: () => Promise<AgentProcess>,
    private readonly spawnReview: () => Promise<AgentProcess>,
    readonly git: GitPort,
    private readonly detectCredit: (result: AgentResult, stderr: string) => CreditSignal | null,
    private readonly persistState: (path: string, state: OrchestratorState) => Promise<void>,
    private readonly _isCleanReview: (text: string) => boolean,
    private readonly spawnVerify: () => Promise<AgentProcess>,
    private readonly _measureDiff: (cwd: string, since: string) => Promise<DiffStats>,
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
        this.hud.setActivity("");
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
    const signal = this.detectCredit(result, agent.stderr);
    if (!signal) return;
    this.log(`Credit exhaustion detected: ${signal.message}`);
    await this.persistState(this.config.stateFile, this.state);
    throw new CreditExhaustedError(signal.message, signal.kind);
  }

  async runSlice(
    slice: Slice,
    reviewBase: string,
    tddResult: AgentResult,
    verifyBaseSha: string,
  ): Promise<{ reviewBase: string; skipped: boolean }> {
    // Already-implemented detection
    const tddText = tddResult.assistantText ?? "";
    const headAfterTdd = await this.git.captureRef(this.config.cwd);
    if (this.isAlreadyImplemented(tddText, headAfterTdd, reviewBase)) {
      this.log(`${ts()} ⏩ Slice ${slice.number} already implemented — skipping verify/review`);
      this.state = {
        ...this.state,
        lastSliceImplemented: slice.number,
        lastCompletedSlice: slice.number,
      };
      await this.persistState(this.config.stateFile, this.state);
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
    await this.persistState(this.config.stateFile, this.state);

    // Review-fix loop — gated on minimum diff threshold
    const diffStats = await this._measureDiff(this.config.cwd, reviewBase);
    if (!shouldReview(diffStats, this.config.reviewThreshold)) {
      this.log(`${ts()} Diff too small (${diffStats.total} lines) — deferring review`);
      this.state = { ...this.state, lastCompletedSlice: slice.number };
      await this.persistState(this.config.stateFile, this.state);
      this.slicesCompleted++;
      return { reviewBase, skipped: false };
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    await this.reviewFix(slice.content, reviewBase);
    const newReviewBase = await this.git.captureRef(this.config.cwd);

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
    await this.persistState(this.config.stateFile, this.state);
    this.slicesCompleted++;
    this.hud.update({ activeAgent: undefined, activeAgentActivity: undefined });
    return { reviewBase: newReviewBase, skipped: false };
  }

  onToolUse(summary: string): void {
    this.activityShowing = true;
    this.hud.setActivity(summary);
  }

  async verify(slice: Slice, verifyBaseSha: string): Promise<boolean> {
    this.hud.update({ activeAgent: "VFY", activeAgentActivity: "verifying..." });
    this.log(`${ts()} ${BOT_VERIFY.badge} verifying slice ${slice.number}...`);

    const verifyAgent = await this.spawnVerify();
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

    for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
      if (this.sliceSkipFlag) break;

      this.log(`${ts()} ${BOT_REVIEW.badge} review cycle ${cycle}/${this.config.maxReviewCycles}`);

      if (!(await this.git.hasChanges(this.config.cwd, reviewSha))) {
        this.log(`${ts()} no diff — skipping review`);
        break;
      }

      this.hud.update({ activeAgent: "REV", activeAgentActivity: `reviewing (cycle ${cycle})...` });
      const reviewPrompt = this.reviewIsFirst
        ? withBrief(buildReviewPrompt(content, reviewSha), this.config.brief)
        : buildReviewPrompt(content, reviewSha);
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

      if (!reviewText || this._isCleanReview(reviewText)) {
        this.log(`${ts()} ${a.green}✓ Review clean — no findings.${a.reset}`);
        break;
      }

      this.hud.update({ activeAgent: "TDD", activeAgentActivity: "fixing review feedback..." });
      this.log(`${ts()} ${BOT_TDD.badge} fixing review feedback...`);
      const preFixSha = await this.git.captureRef(this.config.cwd);
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

      if (!(await this.git.hasChanges(this.config.cwd, preFixSha))) {
        this.log(`${ts()} TDD bot made no changes — review cycle complete`);
        break;
      }

      reviewSha = await this.git.captureRef(this.config.cwd);
    }
  }

  async commitSweep(groupName: string): Promise<void> {
    const dirty = await this.git.hasDirtyTree(this.config.cwd);
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
    this.tddAgent = await this.spawnTdd();
    this.reviewAgent = await this.spawnReview();
    this.tddIsFirst = true;
    this.reviewIsFirst = true;
  }

  run(): never {
    throw new Error("Orchestrator.run() not yet implemented");
  }

  async respawnTdd(): Promise<void> {
    this.tddAgent.kill();
    this.tddAgent = await this.spawnTdd();
    this.tddIsFirst = true;
    this.reviewIsFirst = true;
  }
}
