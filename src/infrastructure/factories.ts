import { spawn } from "node:child_process";
import { AgentSpawner, type AgentHandle } from "#application/ports/agent-spawner.port.js";
import type { RuntimeInteractionGate } from "#application/ports/runtime-interaction.port.js";
import type { AgentRole } from "#domain/agent-types.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { ClaudeAgentSpawner } from "#infrastructure/agent/claude-agent-spawner.js";
import { CodexAgentSpawner } from "#infrastructure/agent/codex-agent-spawner.js";

class ProviderAwareAgentSpawner extends AgentSpawner {
  constructor(
    private readonly config: OrchestratorConfig,
    private readonly claude: ClaudeAgentSpawner,
    private readonly codex: CodexAgentSpawner,
  ) {
    super();
  }

  spawn(
    role: AgentRole,
    opts?: {
      readonly resumeSessionId?: string;
      readonly systemPrompt?: string;
      readonly cwd?: string;
      readonly planMode?: boolean;
      readonly model?: string;
    },
  ): AgentHandle {
    switch (this.config.agentConfig[role].provider) {
      case "claude":
        return this.claude.spawn(role, opts);
      case "codex":
        return this.codex.spawn(role, opts);
    }
  }
}

export const agentSpawnerFactory = (
  config: OrchestratorConfig,
  runtimeInteractionGate: RuntimeInteractionGate,
): AgentSpawner => {
  const claude = new ClaudeAgentSpawner(config.skills, config.cwd);
  const codex = new CodexAgentSpawner(
    config.cwd,
    { auto: config.auto },
    (cwd) => spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    runtimeInteractionGate,
  );

  return new ProviderAwareAgentSpawner(config, claude, codex);
};

agentSpawnerFactory.inject = ["config", "runtimeInteractionGate"] as const;
