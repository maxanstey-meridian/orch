import {
  OperatorGate,
  type GateDecision,
  type VerifyDecision,
  type CreditDecision,
} from "#application/ports/operator-gate.port.js";
import {
  ProgressSink,
  type InterruptHandler,
  type ProgressUpdate,
} from "#application/ports/progress-sink.port.js";
import type { ExecutionMode } from "#domain/config.js";
import type { AgentRole, AgentStyle } from "#domain/agent-types.js";
import type { Slice } from "#domain/plan.js";
import { makeStreamer } from "#infrastructure/agent/streamer.js";
import { ROLE_STYLES } from "./agent-role-styles.js";
import { printExecutionModeBanner, printSliceIntro } from "./display.js";
import type { Hud } from "./hud.js";

export class SilentOperatorGate implements OperatorGate {
  constructor(private readonly hud?: Hud) {}

  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    return { kind: "accept" };
  }

  async verifyFailed(
    _executionUnitLabel: string,
    _summary: string,
    _retryable: boolean,
  ): Promise<VerifyDecision> {
    return { kind: "stop" };
  }

  async creditExhausted(label: string, message: string): Promise<CreditDecision> {
    if (!this.hud) {
      return { kind: "quit" };
    }
    const answer = await this.hud.askUser(
      `Credit exhaustion during ${label}:\n${message}\n\nWait for credits to reset, then (r)etry / (q)uit? `,
    );
    const choice = answer.trim().toLowerCase();
    if (choice === "q") {
      return { kind: "quit" };
    }
    return { kind: "retry" };
  }

  async askUser(_prompt: string): Promise<string> {
    return "";
  }

  async confirmNextGroup(_groupLabel: string): Promise<boolean> {
    return true;
  }
}

export const styleForRole = (role: AgentRole): AgentStyle => {
  return ROLE_STYLES[role];
};

export class SilentProgressSink implements ProgressSink {
  registerInterrupts(): InterruptHandler {
    return {
      onGuide: () => {},
      onInterrupt: () => {},
      onSkip: () => {},
      onQuit: () => {},
    };
  }

  updateProgress(_update: ProgressUpdate): void {}

  setActivity(_summary: string): void {}

  log(_text: string): void {}

  logExecutionMode(_executionMode: ExecutionMode): void {}

  createStreamer(_role: AgentRole): (text: string) => void {
    return () => {};
  }

  logSliceIntro(_slice: Slice): void {}

  logBadge(_role: AgentRole, _phase: string): void {}

  clearSkipping(): void {}

  teardown(): void {}
}

export class InkOperatorGate implements OperatorGate {
  constructor(private readonly hud: Hud) {}

  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    const answer = await this.hud.askUser("Accept plan? (y)es / (e)dit / (r)eplan: ");
    const choice = answer.trim().toLowerCase();
    if (choice === "" || choice.startsWith("y")) {
      return { kind: "accept" };
    }
    if (choice.startsWith("r")) {
      return { kind: "reject" };
    }
    if (choice.startsWith("e")) {
      const guidance = await this.hud.askUser("Guidance for execution: ");
      return { kind: "edit", guidance };
    }
    return { kind: "accept" };
  }

  async verifyFailed(
    executionUnitLabel: string,
    summary: string,
    retryable: boolean,
  ): Promise<VerifyDecision> {
    const answer = await this.hud.askUser(
      retryable
        ? `${executionUnitLabel} verification failed:\n${summary}\n\n(r)etry / (s)kip / s(t)op? `
        : `${executionUnitLabel} verification failed:\n${summary}\n\n(s)kip / s(t)op? `,
    );
    const choice = answer.trim().toLowerCase();
    if (retryable && choice === "r") {
      return { kind: "retry" };
    }
    if (choice === "s") {
      return { kind: "skip" };
    }
    if (choice === "t") {
      return { kind: "stop" };
    }
    return retryable ? { kind: "retry" } : { kind: "stop" };
  }

  async creditExhausted(label: string, message: string): Promise<CreditDecision> {
    const answer = await this.hud.askUser(
      `Credit exhaustion during ${label}:\n${message}\n\n(r)etry / (q)uit? `,
    );
    const choice = answer.trim().toLowerCase();
    if (choice === "q") {
      return { kind: "quit" };
    }
    return { kind: "retry" };
  }

  async askUser(prompt: string): Promise<string> {
    return this.hud.askUser(prompt);
  }

  async confirmNextGroup(groupLabel: string): Promise<boolean> {
    const answer = await this.hud.askUser(`Continue to ${groupLabel}? (Y/n): `);
    return answer.trim().toLowerCase() !== "n";
  }
}

export class InkProgressSink implements ProgressSink {
  private readonly writer: (text: string) => void;
  private readonly logFn: (...args: unknown[]) => void;
  private skipping = false;

  constructor(private readonly hud: Hud) {
    this.writer = hud.createWriter();
    this.logFn = hud.wrapLog(() => {});
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
      if (mode === "guide" && guideCallback) {
        guideCallback(text);
      }
      if (mode === "interrupt" && interruptCallback) {
        interruptCallback(text);
      }
    });

    return {
      onGuide: (cb) => {
        guideCallback = cb;
      },
      onInterrupt: (cb) => {
        interruptCallback = cb;
      },
      onSkip: (cb) => {
        skipCallback = cb;
      },
      onQuit: (cb) => {
        quitCallback = cb;
      },
    };
  }

  updateProgress(update: ProgressUpdate): void {
    this.hud.update(update);
  }

  setActivity(summary: string): void {
    this.hud.setActivity(summary);
  }

  log(text: string): void {
    this.writer(text);
  }

  logExecutionMode(executionMode: ExecutionMode): void {
    printExecutionModeBanner(this.logFn, executionMode);
  }

  createStreamer(role: AgentRole): (text: string) => void {
    return makeStreamer(styleForRole(role), this.writer);
  }

  logSliceIntro(slice: Slice): void {
    printSliceIntro(this.logFn, slice);
  }

  logBadge(role: AgentRole, phase: string): void {
    const style = styleForRole(role);
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    this.logFn(`\n${ts}  ${style.badge}  ${phase}`);
  }

  clearSkipping(): void {
    if (!this.skipping) {
      return;
    }
    this.skipping = false;
    this.hud.setSkipping(false);
  }

  teardown(): void {
    this.hud.teardown();
  }
}
