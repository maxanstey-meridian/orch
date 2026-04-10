import {
  type CreditDecision,
  type GateDecision,
  OperatorGate,
  type VerifyDecision,
} from "#application/ports/operator-gate.port.js";
import type { Hud } from "#ui/hud.js";

const normalizeChoice = (answer: string): string => answer.trim().toLowerCase();

export class InkOperatorGate implements OperatorGate {
  constructor(private readonly hud: Hud) {}

  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    const choice = normalizeChoice(
      await this.hud.askUser("Accept plan? (y)es / (e)dit / (r)eplan: "),
    );

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
    const prompt = retryable
      ? `${executionUnitLabel} verification failed:\n${summary}\n\n(r)etry / (s)kip / s(t)op? `
      : `${executionUnitLabel} verification failed:\n${summary}\n\n(s)kip / s(t)op? `;

    const choice = normalizeChoice(await this.hud.askUser(prompt));

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
    const choice = normalizeChoice(
      await this.hud.askUser(`Credit exhaustion during ${label}:\n${message}\n\n(r)etry / (q)uit? `),
    );

    if (choice === "q") {
      return { kind: "quit" };
    }

    return { kind: "retry" };
  }

  async askUser(prompt: string): Promise<string> {
    return this.hud.askUser(prompt);
  }

  async confirmNextGroup(groupLabel: string): Promise<boolean> {
    const choice = normalizeChoice(await this.hud.askUser(`Continue to ${groupLabel}? (Y/n): `));
    return choice !== "n";
  }
}
