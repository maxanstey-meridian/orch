import { createInjector } from "typed-inject";
import type { OrchestratorConfig } from "./domain/config.js";
import type { Hud } from "./ui/hud.js";
import {
  agentSpawnerFactory,
  statePersistenceFactory,
  gitOpsFactory,
  promptBuilderFactory,
  operatorGateFactory,
} from "./infrastructure/factories.js";
import { RunOrchestration } from "./application/run-orchestration.js";

export const createContainer = (config: OrchestratorConfig, hud: Hud) =>
  createInjector()
    .provideValue("config", config)
    .provideValue("hud", hud)
    .provideFactory("agentSpawner", agentSpawnerFactory)
    .provideFactory("statePersistence", statePersistenceFactory)
    .provideFactory("gitOps", gitOpsFactory)
    .provideFactory("promptBuilder", promptBuilderFactory)
    .provideFactory("operatorGate", operatorGateFactory)
    .provideClass("runOrchestration", RunOrchestration);
