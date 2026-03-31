import {
  RuntimeInteractionGate,
  type RuntimeInteractionRequest,
  type RuntimeInteractionDecision,
} from "../application/ports/runtime-interaction.port.js";
import type { Hud } from "./hud.js";

export class SilentRuntimeInteractionGate implements RuntimeInteractionGate {
  async decide(_request: RuntimeInteractionRequest): Promise<RuntimeInteractionDecision> {
    return { kind: "approve" };
  }
}

export class InkRuntimeInteractionGate implements RuntimeInteractionGate {
  constructor(private readonly hud: Hud) {}

  async decide(request: RuntimeInteractionRequest): Promise<RuntimeInteractionDecision> {
    const answer = await this.hud.askUser(`${request.summary} — (y)es / (n)o / (c)ancel: `);
    const choice = answer.trim().toLowerCase();

    if (choice === "n" || choice === "no") {
      return { kind: "reject" };
    }
    if (choice === "c" || choice === "cancel") {
      return { kind: "cancel" };
    }
    return { kind: "approve" };
  }
}
