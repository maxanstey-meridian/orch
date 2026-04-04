import { createInjector } from "typed-inject";
import { RunOrchestration } from "#application/run-orchestration.js";
import type { OrchestratorConfig } from "#domain/config.js";
import {
  agentSpawnerFactory,
  statePersistenceFactory,
  logWriterFactory,
  gitOpsFactory,
  promptBuilderFactory,
  operatorGateFactory,
  progressSinkFactory,
  runtimeInteractionGateFactory,
  rolePromptResolverFactory,
  executionUnitTierSelectorFactory,
  executionUnitTriagerFactory,
} from "#infrastructure/factories.js";
import type { Hud } from "#ui/hud.js";

export const createContainer = (config: OrchestratorConfig, hud: Hud) =>
  createInjector()
    .provideValue("config", config)
    .provideValue("hud", hud)
    .provideFactory("runtimeInteractionGate", runtimeInteractionGateFactory)
    .provideFactory("agentSpawner", agentSpawnerFactory)
    .provideFactory("statePersistence", statePersistenceFactory)
    .provideFactory("logWriter", logWriterFactory)
    .provideFactory("gitOps", gitOpsFactory)
    .provideFactory("promptBuilder", promptBuilderFactory)
    .provideFactory("operatorGate", operatorGateFactory)
    .provideFactory("progressSink", progressSinkFactory)
    .provideFactory("rolePromptResolver", rolePromptResolverFactory)
    .provideFactory("executionUnitTierSelector", executionUnitTierSelectorFactory)
    .provideFactory("executionUnitTriager", executionUnitTriagerFactory)
    .provideClass("runOrchestration", RunOrchestration);
