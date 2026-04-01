import type { AgentStyle, AgentResult, AgentRole } from "#domain/agent-types.js";

export type AgentHandle = {
  readonly sessionId: string;
  readonly style: AgentStyle;
  readonly alive: boolean;
  readonly stderr: string;
  send(
    prompt: string,
    onText?: (text: string) => void,
    onToolUse?: (summary: string) => void,
  ): Promise<AgentResult>;
  sendQuiet(prompt: string): Promise<string>;
  inject(message: string): void;
  kill(): void;
  pipe(onText: (text: string) => void, onToolUse: (summary: string) => void): void;
};

export type PromptAgent = Pick<AgentHandle, "send" | "kill">;

export abstract class AgentSpawner {
  abstract spawn(
    role: AgentRole,
    opts?: {
      readonly resumeSessionId?: string;
      readonly systemPrompt?: string;
      readonly cwd?: string;
      readonly planMode?: boolean;
      readonly model?: string;
    },
  ): AgentHandle;
}
