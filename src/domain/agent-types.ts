export type AgentStyle = {
  readonly label: string;
  readonly color: string;
  readonly badge: string;
};

export type AgentResult = {
  readonly exitCode: number;
  readonly assistantText: string;
  readonly resultText: string;
  readonly needsInput: boolean;
  readonly sessionId: string;
  readonly planText?: string;
};
