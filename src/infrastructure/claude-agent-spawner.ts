import { AgentSpawner, type AgentHandle } from "../application/ports/agent-spawner.port.js";
import type { AgentRole } from "../domain/agent-types.js";
import { ROLE_STYLES } from "../ui/agent-role-styles.js";
import { spawnClaudeAgent, spawnClaudePlanAgent } from "./claude/claude-agent-factory.js";

const PLAN_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  "plan",
  "gap",
  "completeness",
  "triage",
]);
const TRIAGE_MODEL = "claude-haiku-4-5-20251001";

export class ClaudeAgentSpawner implements AgentSpawner {
  constructor(
    private readonly skills: Partial<Record<AgentRole, string | null>>,
    private readonly defaultCwd: string,
  ) {}

  spawn(
    role: AgentRole,
    opts?: {
      readonly resumeSessionId?: string;
      readonly systemPrompt?: string;
      readonly cwd?: string;
      readonly planMode?: boolean;
    },
  ): AgentHandle {
    const style = ROLE_STYLES[role];
    const systemPrompt = opts?.systemPrompt ?? this.skills[role] ?? undefined;
    const cwd = opts?.cwd ?? this.defaultCwd;
    const usePlanAgent = opts?.planMode || PLAN_ROLES.has(role);

    const process = usePlanAgent
      ? role === "triage"
        ? spawnClaudePlanAgent(style, systemPrompt, cwd, TRIAGE_MODEL)
        : spawnClaudePlanAgent(style, systemPrompt, cwd)
      : spawnClaudeAgent(style, systemPrompt, opts?.resumeSessionId, cwd);

    return process;
  }
}
