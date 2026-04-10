import {
  RuntimeInteractionGate,
  type RuntimeInteractionDecision,
  type RuntimeInteractionRequest,
} from "#application/ports/runtime-interaction.port.js";

export class SilentRuntimeInteractionGate implements RuntimeInteractionGate {
  async decide(_request: RuntimeInteractionRequest): Promise<RuntimeInteractionDecision> {
    return { kind: "approve" };
  }
}
