import type { AgentProcess, AgentResult, AgentStyle } from "./agent.js";
import type { Hud, WriteFn } from "./hud.js";
import type { OrchestratorState } from "./state.js";
import { a, ts, BOT_TDD, BOT_REVIEW } from "./display.js";
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
  readonly config: OrchestratorConfig;
  state: OrchestratorState;
  readonly hud: Hud;
  readonly log: LogFn;

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

  private readonly spawnTdd: () => Promise<AgentProcess>;
  private readonly spawnReview: () => Promise<AgentProcess>;
  private readonly hudWriter: WriteFn;
  readonly git: GitPort;
  private readonly detectCredit: (result: AgentResult, stderr: string) => CreditSignal | null;
  private readonly persistState: (path: string, state: OrchestratorState) => Promise<void>;
  private readonly _isCleanReview: (text: string) => boolean;

  constructor(
    config: OrchestratorConfig,
    initialState: OrchestratorState,
    hud: Hud,
    log: LogFn,
    tddAgent: AgentProcess,
    reviewAgent: AgentProcess,
    spawnTdd: () => Promise<AgentProcess>,
    spawnReview: () => Promise<AgentProcess>,
    git: GitPort,
    detectCredit: (result: AgentResult, stderr: string) => CreditSignal | null,
    persistState: (path: string, state: OrchestratorState) => Promise<void>,
    isCleanReview: (text: string) => boolean,
  ) {
    this.config = config;
    this.state = initialState;
    this.hud = hud;
    this.log = log;
    this.tddAgent = tddAgent;
    this.reviewAgent = reviewAgent;
    this.spawnTdd = spawnTdd;
    this.spawnReview = spawnReview;
    this.hudWriter = hud.createWriter();
    this.git = git;
    this.detectCredit = detectCredit;
    this.persistState = persistState;
    this._isCleanReview = isCleanReview;
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
