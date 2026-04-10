import { AgentSpawner, type AgentHandle } from "#application/ports/agent-spawner.port.js";
import type { AgentRole, AgentStyle } from "#domain/agent-types.js";
import { spawnClaudeAgent, spawnClaudePlanAgent } from "#infrastructure/agent/claude-process.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgMagenta: "\x1b[45m\x1b[30m",
  bgGreen: "\x1b[42m\x1b[30m",
} as const;

export const ROLE_STYLES: Readonly<Record<AgentRole, AgentStyle>> = {
  tdd: {
    label: "TDD",
    color: ANSI.cyan,
    badge: `${ANSI.bgCyan} TDD ${ANSI.reset}`,
  },
  review: {
    label: "REVIEW",
    color: ANSI.magenta,
    badge: `${ANSI.bgMagenta} REV ${ANSI.reset}`,
  },
  verify: {
    label: "VERIFY",
    color: ANSI.green,
    badge: `${ANSI.bgGreen} VFY ${ANSI.reset}`,
  },
  plan: {
    label: "PLAN",
    color: ANSI.white,
    badge: `${ANSI.bold}${ANSI.white} PLN ${ANSI.reset}`,
  },
  gap: {
    label: "GAP",
    color: ANSI.yellow,
    badge: `${ANSI.yellow}${ANSI.bold} GAP ${ANSI.reset}`,
  },
  final: {
    label: "FINAL",
    color: ANSI.green,
    badge: `${ANSI.bgGreen} FIN ${ANSI.reset}`,
  },
  completeness: {
    label: "PLAN",
    color: ANSI.white,
    badge: `${ANSI.bold}${ANSI.white} PLN ${ANSI.reset}`,
  },
  triage: {
    label: "Triage",
    color: "#888",
    badge: "[TRG]",
  },
};

const PLAN_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  "plan",
  "gap",
  "completeness",
  "triage",
]);

const TRIAGE_MODEL = "claude-haiku-4-5-20251001";

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
      readonly model?: string;
    },
  ): AgentHandle {
    const systemPrompt = opts?.systemPrompt ?? this.skills[role] ?? undefined;
    const cwd = opts?.cwd ?? this.defaultCwd;
    const model = role === "triage" ? (opts?.model ?? TRIAGE_MODEL) : opts?.model;

    if (opts?.planMode || PLAN_ROLES.has(role)) {
      return spawnClaudePlanAgent(ROLE_STYLES[role], systemPrompt, cwd, model);
    }

    return spawnClaudeAgent(ROLE_STYLES[role], systemPrompt, opts?.resumeSessionId, cwd, model);
  }
}
