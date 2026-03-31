import type { OrchestratorConfig, Provider } from "../domain/config.js";
import { spawn } from "node:child_process";
import { spawnClaudeGeneratePlanAgent } from "./claude/claude-agent-factory.js";
import type { Hud } from "../ui/hud.js";
import { ClaudeAgentSpawner } from "./claude-agent-spawner.js";
import { CodexAgentSpawner } from "./codex/codex-agent-spawner.js";
import { FsStatePersistence } from "./fs-state-persistence.js";
import { ChildProcessGitOps } from "./child-process-git-ops.js";
import { DefaultPromptBuilder } from "./default-prompt-builder.js";
import { InkOperatorGate, SilentOperatorGate, InkProgressSink } from "../ui/ink-operator-gate.js";
import {
  SilentRuntimeInteractionGate,
  InkRuntimeInteractionGate,
} from "../ui/ink-runtime-interaction-gate.js";
import type { OperatorGate } from "../application/ports/operator-gate.port.js";
import type { ProgressSink } from "../application/ports/progress-sink.port.js";
import type { RuntimeInteractionGate } from "../application/ports/runtime-interaction.port.js";

export const agentSpawnerFactory = (
  config: OrchestratorConfig,
  runtimeInteractionGate: RuntimeInteractionGate,
) => {
  switch (config.provider) {
    case "claude":
      return new ClaudeAgentSpawner(
        { tdd: config.tddSkill, review: config.reviewSkill, verify: config.verifySkill },
        config.cwd,
      );
    case "codex":
      return new CodexAgentSpawner(
        config.cwd,
        { auto: config.auto },
        () => spawn("codex", ["app-server"], { cwd: config.cwd, stdio: ["pipe", "pipe", "pipe"] }),
        runtimeInteractionGate,
      );
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
};
agentSpawnerFactory.inject = ["config", "runtimeInteractionGate"] as const;

export const statePersistenceFactory = (config: OrchestratorConfig) =>
  new FsStatePersistence(config.stateFile);
statePersistenceFactory.inject = ["config"] as const;

export const gitOpsFactory = (config: OrchestratorConfig) => new ChildProcessGitOps(config.cwd);
gitOpsFactory.inject = ["config"] as const;

export const promptBuilderFactory = (config: OrchestratorConfig) =>
  new DefaultPromptBuilder(config.brief, config.planContent, config.tddRules, config.reviewRules);
promptBuilderFactory.inject = ["config"] as const;

export const operatorGateFactory = (config: OrchestratorConfig, hud: Hud): OperatorGate =>
  config.auto ? new SilentOperatorGate(hud) : new InkOperatorGate(hud);
operatorGateFactory.inject = ["config", "hud"] as const;

export const progressSinkFactory = (_config: OrchestratorConfig, hud: Hud): ProgressSink =>
  new InkProgressSink(hud);
progressSinkFactory.inject = ["config", "hud"] as const;

export const runtimeInteractionGateFactory = (
  config: OrchestratorConfig,
  hud: Hud,
): RuntimeInteractionGate =>
  config.auto ? new SilentRuntimeInteractionGate() : new InkRuntimeInteractionGate(hud);
runtimeInteractionGateFactory.inject = ["config", "hud"] as const;

export const planGeneratorSpawnerFactory = (opts: { provider: Provider; cwd: string }) => {
  switch (opts.provider) {
    case "claude":
      return () => spawnClaudeGeneratePlanAgent(opts.cwd);
    case "codex":
      throw new Error("Codex provider is not yet implemented");
    default: {
      const _exhaustive: never = opts.provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
};
