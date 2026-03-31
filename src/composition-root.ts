import { createInjector } from "typed-inject";
import { RunOrchestration } from "#application/run-orchestration.js";
import type { OrchestratorConfig } from "#domain/config.js";
import {
  agentSpawnerFactory,
  statePersistenceFactory,
  gitOpsFactory,
  promptBuilderFactory,
  operatorGateFactory,
  progressSinkFactory,
  runtimeInteractionGateFactory,
} from "#infrastructure/factories.js";
import type { Hud } from "#ui/hud.js";

export const createContainer = (config: OrchestratorConfig, hud: Hud) =>
  createInjector()
    .provideValue("config", config)
    .provideValue("hud", hud)
    .provideFactory("runtimeInteractionGate", runtimeInteractionGateFactory)
    .provideFactory("agentSpawner", agentSpawnerFactory)
    .provideFactory("statePersistence", statePersistenceFactory)
    .provideFactory("gitOps", gitOpsFactory)
    .provideFactory("promptBuilder", promptBuilderFactory)
    .provideFactory("operatorGate", operatorGateFactory)
    .provideFactory("progressSink", progressSinkFactory)
    .provideClass("runOrchestration", RunOrchestration);
