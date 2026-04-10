import {
  ProgressSink,
  type InterruptHandler,
  type ProgressUpdate,
} from "#application/ports/progress-sink.port.js";
import type { AgentRole, AgentStyle } from "#domain/agent-types.js";
import type { ExecutionMode } from "#domain/config.js";
import type { Slice } from "#domain/plan.js";
import { makeStreamer } from "#infrastructure/agent/streamer.js";
import { ROLE_STYLES } from "./agent-role-styles.js";
import { printExecutionModeBanner, printSliceIntro } from "./display.js";
import type { Hud } from "./hud.js";

const DEFAULT_PLANNING_DELAY_MS = 1_000;

export const styleForRole = (role: AgentRole): AgentStyle => ROLE_STYLES[role];

export class InkProgressSink implements ProgressSink {
  private readonly writer: (text: string) => void;
  private readonly logFn: (...args: unknown[]) => void;
  private readonly planningDelayMs: number;
  private skipping = false;
  private planningTimer: NodeJS.Timeout | null = null;
  private activityGeneration = 0;

  constructor(
    private readonly hud: Hud,
    opts?: {
      readonly planningDelayMs?: number;
    },
  ) {
    this.writer = hud.createWriter();
    this.logFn = hud.wrapLog(() => {});
    this.planningDelayMs = opts?.planningDelayMs ?? DEFAULT_PLANNING_DELAY_MS;
  }

  registerInterrupts(): InterruptHandler {
    let guideCallback: ((text: string) => void) | null = null;
    let interruptCallback: ((text: string) => void) | null = null;
    let skipCallback: (() => boolean) | null = null;
    let quitCallback: (() => void) | null = null;

    this.hud.onKey((key) => {
      const normalized = key.toLowerCase();
      if (normalized === "g") {
        this.hud.startPrompt("guide");
      }
      if (normalized === "i") {
        this.hud.startPrompt("interrupt");
      }
      if (normalized === "s" && skipCallback?.()) {
        this.skipping = !this.skipping;
        this.hud.setSkipping(this.skipping);
      }
      if (normalized === "q") {
        quitCallback?.();
      }
    });

    this.hud.onInterruptSubmit((text, mode) => {
      if (mode === "guide") {
        guideCallback?.(text);
      }
      if (mode === "interrupt") {
        interruptCallback?.(text);
      }
    });

    return {
      onGuide: (callback) => {
        guideCallback = callback;
      },
      onInterrupt: (callback) => {
        interruptCallback = callback;
      },
      onSkip: (callback) => {
        skipCallback = callback;
      },
      onQuit: (callback) => {
        quitCallback = callback;
      },
    };
  }

  updateProgress(update: ProgressUpdate): void {
    this.hud.update(update);
  }

  setActivity(summary: string): void {
    this.activityGeneration += 1;
    this.clearPlanningTimer();
    this.hud.setActivity(summary);
  }

  log(text: string): void {
    this.writer(text);
  }

  logExecutionMode(executionMode: ExecutionMode): void {
    this.hud.update({ executionMode });
    printExecutionModeBanner(this.logFn, executionMode);
  }

  createStreamer(role: AgentRole): (text: string) => void {
    const streamer = makeStreamer(styleForRole(role), this.writer);

    return (text: string) => {
      if (text.trim().length > 0) {
        this.schedulePlanningActivity();
      }
      streamer(text);
    };
  }

  logSliceIntro(slice: Slice): void {
    printSliceIntro(this.logFn, slice);
  }

  logBadge(role: AgentRole, phase: string): void {
    const style = styleForRole(role);
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    this.logFn(`\n${time}  ${style.badge}  ${phase}`);
  }

  clearSkipping(): void {
    if (!this.skipping) {
      return;
    }
    this.skipping = false;
    this.hud.setSkipping(false);
  }

  teardown(): void {
    this.clearPlanningTimer();
    this.hud.teardown();
  }

  private schedulePlanningActivity(): void {
    const generation = this.activityGeneration;
    this.clearPlanningTimer();
    this.planningTimer = setTimeout(() => {
      this.planningTimer = null;
      if (generation !== this.activityGeneration) {
        return;
      }
      this.hud.setActivity("planning...");
    }, this.planningDelayMs);
  }

  private clearPlanningTimer(): void {
    if (this.planningTimer === null) {
      return;
    }
    clearTimeout(this.planningTimer);
    this.planningTimer = null;
  }
}
