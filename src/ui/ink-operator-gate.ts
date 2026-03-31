import {
  OperatorGate,
  type GateDecision,
  type VerifyDecision,
} from "../application/ports/operator-gate.port.js";
import {
  ProgressSink,
  type InterruptHandler,
  type ProgressUpdate,
} from "../application/ports/progress-sink.port.js";
import type { AgentRole, AgentStyle } from "../domain/agent-types.js";
import type { Slice } from "../domain/plan.js";
import { printSliceIntro } from "./display.js";
import { ROLE_STYLES } from "./agent-role-styles.js";
import { makeStreamer } from "../infrastructure/agent/streamer.js";
import type { Hud } from "./hud.js";

export class SilentOperatorGate extends OperatorGate {
  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    return { kind: "accept" };
  }

  async verifyFailed(_sliceNumber: number, _summary: string): Promise<VerifyDecision> {
    return { kind: "skip" };
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

export class SilentProgressSink extends ProgressSink {
  registerInterrupts(): InterruptHandler {
    return {
      onGuide: () => {},
      onInterrupt: () => {},
    };
  }

  updateProgress(_update: ProgressUpdate): void {}

  setActivity(_summary: string): void {}

  log(_text: string): void {}

  createStreamer(_role: AgentRole): (text: string) => void {
    return () => {};
  }

  logSliceIntro(_slice: Slice): void {}

  logBadge(_role: AgentRole, _phase: string): void {}

  teardown(): void {}
}

export class InkOperatorGate extends OperatorGate {
  constructor(private readonly hud: Hud) {
    super();
  }

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

  async verifyFailed(sliceNumber: number, summary: string): Promise<VerifyDecision> {
    const answer = await this.hud.askUser(
      `Slice ${sliceNumber} verification failed:\n${summary}\n\n(r)etry / (s)kip / s(t)op? `,
    );
    const choice = answer.trim().toLowerCase();
    if (choice === "s") return { kind: "skip" };
    if (choice === "t") return { kind: "stop" };
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

export class InkProgressSink extends ProgressSink {
  private readonly writer: (text: string) => void;
  private readonly logFn: (...args: unknown[]) => void;

  constructor(private readonly hud: Hud) {
    super();
    this.writer = hud.createWriter();
    this.logFn = hud.wrapLog(() => {});
  }

  registerInterrupts(): InterruptHandler {
    let guideCallback: ((text: string) => void) | null = null;
    let interruptCallback: ((text: string) => void) | null = null;

    this.hud.onKey((key) => {
      if (key === "g") this.hud.startPrompt("guide");
      if (key === "i") this.hud.startPrompt("interrupt");
    });

    this.hud.onInterruptSubmit((text, mode) => {
      if (mode === "guide" && guideCallback) guideCallback(text);
      if (mode === "interrupt" && interruptCallback) interruptCallback(text);
    });

    return {
      onGuide: (cb) => {
        guideCallback = cb;
      },
      onInterrupt: (cb) => {
        interruptCallback = cb;
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

  teardown(): void {
    this.hud.teardown();
  }
}
