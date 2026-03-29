import type { OrchestratorConfig } from "../domain/config.js";
import type { Hud } from "../ui/hud.js";
import { ClaudeAgentSpawner } from "./claude-agent-spawner.js";
import { FsStatePersistence } from "./fs-state-persistence.js";
import { ChildProcessGitOps } from "./child-process-git-ops.js";
import { DefaultPromptBuilder } from "./default-prompt-builder.js";
import { InkOperatorGate, SilentOperatorGate } from "../ui/ink-operator-gate.js";
import type { OperatorGate } from "../application/ports/operator-gate.port.js";

export const agentSpawnerFactory = (config: OrchestratorConfig) =>
  new ClaudeAgentSpawner(
    { tdd: config.tddSkill, review: config.reviewSkill, verify: config.verifySkill },
    config.cwd,
  );
agentSpawnerFactory.inject = ["config"] as const;

export const statePersistenceFactory = (config: OrchestratorConfig) =>
  new FsStatePersistence(config.stateFile);
statePersistenceFactory.inject = ["config"] as const;

export const gitOpsFactory = (config: OrchestratorConfig) =>
  new ChildProcessGitOps(config.cwd);
gitOpsFactory.inject = ["config"] as const;

export const promptBuilderFactory = (config: OrchestratorConfig) =>
  new DefaultPromptBuilder(config.brief, config.planContent, config.tddRules, config.reviewRules);
promptBuilderFactory.inject = ["config"] as const;

export const operatorGateFactory = (config: OrchestratorConfig, hud: Hud): OperatorGate =>
  config.noInteraction ? new SilentOperatorGate() : new InkOperatorGate(hud);
operatorGateFactory.inject = ["config", "hud"] as const;
