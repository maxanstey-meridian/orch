import type { AgentRole } from "./agent-types.js";
import { AGENT_ROLES } from "./agent-types.js";
import type { Provider } from "./config.js";

export type ResolvedAgentConfig = {
  readonly provider: Provider;
  readonly model?: string;
};

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export const CLAUDE_MODEL_IDS: Record<ClaudeModel, string> = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
};

const VALID_PROVIDERS: readonly string[] = ["claude", "codex"];
const VALID_CLAUDE_MODELS = Object.keys(CLAUDE_MODEL_IDS);

export const parseAgentConfigValue = (value: string): ResolvedAgentConfig => {
  if (VALID_PROVIDERS.includes(value)) {
    return { provider: value as Provider };
  }

  const [providerStr, modelStr] = value.split(":");
  if (providerStr === "claude" && VALID_CLAUDE_MODELS.includes(modelStr)) {
    return { provider: "claude", model: CLAUDE_MODEL_IDS[modelStr as ClaudeModel] };
  }

  throw new Error(`Invalid agent config value: ${value}`);
};

export const resolveAgentConfig = (
  role: AgentRole,
  agents: Partial<Record<AgentRole, string>> | undefined,
  cliProvider: Provider,
): ResolvedAgentConfig => {
  const entry = agents?.[role];
  if (entry !== undefined) {
    return parseAgentConfigValue(entry);
  }
  if (cliProvider !== "claude") {
    return { provider: cliProvider };
  }
  return AGENT_DEFAULTS[role];
};

export const resolveAllAgentConfigs = (
  agents: Partial<Record<AgentRole, string>> | undefined,
  cliProvider: Provider,
): Record<AgentRole, ResolvedAgentConfig> =>
  Object.fromEntries(
    AGENT_ROLES.map((role) => [role, resolveAgentConfig(role, agents, cliProvider)]),
  ) as Record<AgentRole, ResolvedAgentConfig>;

export const AGENT_DEFAULTS: Record<AgentRole, ResolvedAgentConfig> = Object.fromEntries(
  AGENT_ROLES.map((role) => [role, { provider: "claude" as const }]),
) as Record<AgentRole, ResolvedAgentConfig>;
