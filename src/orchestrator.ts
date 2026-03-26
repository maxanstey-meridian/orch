import type { AgentProcess, AgentStyle } from "./agent.js";
import type { Hud, WriteFn } from "./hud.js";
import type { OrchestratorState } from "./state.js";
import type { LogFn } from "./display.js";
import { makeStreamer, type Streamer } from "./streamer.js";

export type OrchestratorConfig = {
  readonly cwd: string;
  readonly planPath: string;
  readonly planContent: string;
  readonly brief: string;
  readonly noInteraction: boolean;
  readonly auto: boolean;
  readonly reviewThreshold: number;
  readonly stateFile: string;
  readonly tddSkill: string;
  readonly reviewSkill: string;
  readonly verifySkill: string;
};

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

  constructor(
    config: OrchestratorConfig,
    initialState: OrchestratorState,
    hud: Hud,
    log: LogFn,
    tddAgent: AgentProcess,
    reviewAgent: AgentProcess,
    spawnTdd: () => Promise<AgentProcess>,
    spawnReview: () => Promise<AgentProcess>,
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
