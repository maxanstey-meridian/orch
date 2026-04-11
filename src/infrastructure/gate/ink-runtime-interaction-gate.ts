import {
  RuntimeInteractionGate,
  type RuntimeInteractionDecision,
  type RuntimeInteractionRequest,
} from "#application/ports/runtime-interaction.port.js";
import type { Hud } from "#ui/hud.js";

const normalizeChoice = (answer: string): string => answer.trim().toLowerCase();

export class InkRuntimeInteractionGate implements RuntimeInteractionGate {
  constructor(private readonly hud: Hud) {}

  async decide(request: RuntimeInteractionRequest): Promise<RuntimeInteractionDecision> {
    const choice = normalizeChoice(
      await this.hud.askUser(`${request.summary} — (y)es / (n)o / (c)ancel: `),
    );

    if (choice === "n" || choice === "no") {
      return { kind: "reject" };
    }

    if (choice === "c" || choice === "cancel") {
      return { kind: "cancel" };
    }

    return { kind: "approve" };
  }
}
