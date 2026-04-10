import type { OrchestratorConfig } from "#domain/config.js";
import { agentSpawnerFactory } from "#infrastructure/factories.js";
import { InkRuntimeInteractionGate, SilentRuntimeInteractionGate } from "#ui/ink-runtime-interaction-gate.js";
import type { Hud } from "#ui/hud.js";

type RunOrchestrationLike = {
  execute: (...args: readonly unknown[]) => Promise<void>;
  dispose: () => void;
};

export type OrchContainer = {
  resolve: (token: "runOrchestration") => RunOrchestrationLike;
};

export const createContainer = (config: OrchestratorConfig, hud: Hud): OrchContainer => {
  const runtimeInteractionGate = config.auto
    ? new SilentRuntimeInteractionGate()
    : new InkRuntimeInteractionGate(hud);

  // Keep the provider-selection path live in production code even while the
  // broader composition root is still being rebuilt slice-by-slice.
  void agentSpawnerFactory(config, runtimeInteractionGate);

  // NOTE: this stub is intentional. The real container wiring is delivered in
  // slice 13 (Wiring and Integration), once slices 9–12 have produced the
  // infrastructure implementations it depends on. Do not "fix" this here —
  // out-of-scope wiring will just get reverted.
  return {
    resolve: () => {
      throw new Error("createContainer runtime wiring has not been restored yet");
    },
  };
};
