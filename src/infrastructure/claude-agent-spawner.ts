import { AgentSpawner, type AgentHandle } from "../application/ports/agent-spawner.port.js";
import type { AgentRole, AgentStyle } from "../domain/agent-types.js";
import { spawnClaudeAgent, spawnClaudePlanAgent } from "./claude/claude-agent-factory.js";
import {
  BOT_TDD,
  BOT_REVIEW,
  BOT_VERIFY,
  BOT_PLAN,
  BOT_GAP,
  BOT_FINAL,
} from "../ui/display.js";

export const ROLE_STYLES: Record<AgentRole, AgentStyle> = {
  tdd: BOT_TDD,
  review: BOT_REVIEW,
  verify: BOT_VERIFY,
  plan: BOT_PLAN,
  gap: BOT_GAP,
  final: BOT_FINAL,
  completeness: BOT_PLAN,
};

const PLAN_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["plan", "gap", "completeness"]);

export class ClaudeAgentSpawner extends AgentSpawner {
  constructor(
    private readonly skills: Partial<Record<AgentRole, string | null>>,
    private readonly defaultCwd: string,
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
    },
  ): AgentHandle {
    const style = ROLE_STYLES[role];
    const systemPrompt = opts?.systemPrompt ?? this.skills[role] ?? undefined;
    const cwd = opts?.cwd ?? this.defaultCwd;
    const usePlanAgent = opts?.planMode || PLAN_ROLES.has(role);

    const process = usePlanAgent
      ? spawnClaudePlanAgent(style, systemPrompt, cwd)
      : spawnClaudeAgent(style, systemPrompt, opts?.resumeSessionId, cwd);

    return process;
  }
}
