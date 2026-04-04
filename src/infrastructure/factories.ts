import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentSpawner, type PromptAgent } from "#application/ports/agent-spawner.port.js";
import type { OperatorGate } from "#application/ports/operator-gate.port.js";
import type { ProgressSink } from "#application/ports/progress-sink.port.js";
import type { RuntimeInteractionGate } from "#application/ports/runtime-interaction.port.js";
import type { ResolvedAgentConfig } from "#domain/agent-config.js";
import type { AgentRole } from "#domain/agent-types.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { ROLE_STYLES } from "#ui/agent-role-styles.js";
import type { Hud } from "#ui/hud.js";
import { InkOperatorGate, SilentOperatorGate, InkProgressSink } from "#ui/ink-operator-gate.js";
import {
  SilentRuntimeInteractionGate,
  InkRuntimeInteractionGate,
} from "#ui/ink-runtime-interaction-gate.js";
import { ChildProcessGitOps } from "./child-process-git-ops.js";
import { ClaudeAgentSpawner } from "./claude-agent-spawner.js";
import {
  spawnClaudeGeneratePlanAgent,
  spawnClaudePlanAgent,
} from "./claude/claude-agent-factory.js";
import { CodexAgentSpawner } from "./codex/codex-agent-spawner.js";
import { DefaultPromptBuilder } from "./default-prompt-builder.js";
import { FsStatePersistence } from "./fs-state-persistence.js";
import { FsLogWriter, NullLogWriter } from "./log/log-writer.js";

const CODEX_TRIAGE_MODEL = "gpt-5.4-mini";

export const agentSpawnerFactory = (
  config: OrchestratorConfig,
  runtimeInteractionGate: RuntimeInteractionGate,
): AgentSpawner => {
  let claudeSpawner: ClaudeAgentSpawner | undefined;
  let codexSpawner: CodexAgentSpawner | undefined;
  let codexTriageSpawner: CodexAgentSpawner | undefined;

  const spawnCodex = (...extraArgs: string[]) =>
    spawn("codex", ["app-server", ...extraArgs], {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

  const getClaudeSpawner = () =>
    (claudeSpawner ??= new ClaudeAgentSpawner(config.skills, config.cwd));

  const getCodexSpawner = () =>
    (codexSpawner ??= new CodexAgentSpawner(
      config.cwd,
      { auto: config.auto },
      () => spawnCodex(),
      runtimeInteractionGate,
    ));

  const getCodexTriageSpawner = () =>
    (codexTriageSpawner ??= new CodexAgentSpawner(
      config.cwd,
      { auto: config.auto },
      () => spawnCodex("-c", `model="${CODEX_TRIAGE_MODEL}"`),
      runtimeInteractionGate,
    ));

  return {
    spawn(role, opts?) {
      const { provider, model } = config.agentConfig[role];
      switch (provider) {
        case "claude":
          return getClaudeSpawner().spawn(role, { ...opts, model: model ?? opts?.model });
        case "codex":
          if (role === "triage") {
            return getCodexTriageSpawner().spawn(role, opts);
          }
          return getCodexSpawner().spawn(role, opts);
        default: {
          const _exhaustive: never = provider;
          throw new Error(`Unknown provider: ${_exhaustive}`);
        }
      }
    },
  };
};
agentSpawnerFactory.inject = ["config", "runtimeInteractionGate"] as const;

const generatePlanSkillContent = readFileSync(
  resolve(import.meta.dirname, "..", "..", "skills", "generate-plan.md"),
  "utf-8",
);

export const statePersistenceFactory = (config: OrchestratorConfig) =>
  new FsStatePersistence(config.stateFile);
statePersistenceFactory.inject = ["config"] as const;

export const logWriterFactory = (config: OrchestratorConfig) =>
  config.logPath === null ? new NullLogWriter() : new FsLogWriter(config.logPath);
logWriterFactory.inject = ["config"] as const;

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

const createCodexPromptAgent = (opts: {
  cwd: string;
  model?: string;
  role: AgentRole;
}): PromptAgent => {
  const spawner = new CodexAgentSpawner(
    opts.cwd,
    { auto: true },
    () =>
      spawn(
        "codex",
        opts.model === undefined ? ["app-server"] : ["app-server", "-c", `model="${opts.model}"`],
        {
          cwd: opts.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    new SilentRuntimeInteractionGate(),
  );
  const handle = spawner.spawn(opts.role, { cwd: opts.cwd });
  return {
    send: (prompt: string) => handle.send(prompt),
    kill: () => handle.kill(),
  };
};

export const planGeneratorSpawnerFactory = (opts: {
  agentConfig: Record<AgentRole, ResolvedAgentConfig>;
  cwd: string;
}) => {
  const { provider, model } = opts.agentConfig.plan;
  switch (provider) {
    case "claude":
      return () => spawnClaudeGeneratePlanAgent(opts.cwd, model);
    case "codex":
      return () => {
        const spawner = new CodexAgentSpawner(
          opts.cwd,
          { auto: true },
          () =>
            spawn("codex", ["app-server"], {
              cwd: opts.cwd,
              stdio: ["pipe", "pipe", "pipe"],
            }),
          new SilentRuntimeInteractionGate(),
        );
        const handle = spawner.spawn("plan", {
          cwd: opts.cwd,
          planMode: true,
          systemPrompt: generatePlanSkillContent,
        });
        return {
          send: (prompt: string) => handle.send(prompt),
          kill: () => handle.kill(),
        };
      };
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
};

export const complexityTriageSpawnerFactory = (opts: {
  agentConfig: Record<AgentRole, ResolvedAgentConfig>;
  cwd: string;
}): (() => PromptAgent) => {
  const { provider, model } = opts.agentConfig.triage;
  switch (provider) {
    case "claude":
      return () => spawnClaudePlanAgent(ROLE_STYLES.triage, undefined, opts.cwd, model);
    case "codex":
      return () =>
        createCodexPromptAgent({
          cwd: opts.cwd,
          model,
          role: "triage",
        });
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
};

export const requestTriageSpawnerFactory = (opts: {
  agentConfig: Record<AgentRole, ResolvedAgentConfig>;
  cwd: string;
}): (() => PromptAgent) => {
  const { provider, model } = opts.agentConfig.triage;
  switch (provider) {
    case "claude":
      return () => spawnClaudePlanAgent(ROLE_STYLES.triage, undefined, opts.cwd, model);
    case "codex":
      return () =>
        createCodexPromptAgent({
          cwd: opts.cwd,
          model,
          role: "triage",
        });
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
};
