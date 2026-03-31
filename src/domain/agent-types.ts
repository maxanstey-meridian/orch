export type AgentStyle = {
  readonly label: string;
  readonly color: string;
  readonly badge: string;
};

export const AGENT_ROLES = [
  "tdd",
  "review",
  "verify",
  "plan",
  "gap",
  "final",
  "completeness",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export type AgentResult = {
  readonly exitCode: number;
  readonly assistantText: string;
  readonly resultText: string;
  readonly needsInput: boolean;
  readonly sessionId: string;
  readonly planText?: string;
};
