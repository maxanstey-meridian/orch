import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
import type { AgentResult, AgentStyle } from "#domain/agent-types.js";
import { detectQuestion } from "#infrastructure/agent/question-detector.js";

type ToolUseBlock = {
  readonly type: "tool_use";
  readonly name: string;
  readonly input: Record<string, unknown>;
};

type ContentBlock = { readonly type: string; readonly text?: string } | ToolUseBlock;

type AssistantEvent = {
  readonly type: "assistant";
  readonly message: {
    readonly content: readonly ContentBlock[];
  };
};

type ResultEvent = {
  readonly type: "result";
  readonly result: string;
  readonly duration_ms: number;
  readonly num_turns: number;
};

type StreamEvent = AssistantEvent | ResultEvent;

type MessageSource = "send" | "inject";

export type ClaudeAgentProcess = AgentHandle;

type CreateClaudeProcessOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly style: AgentStyle;
  readonly sessionId?: string;
  readonly cwd?: string;
};

const CLAUDE_STREAM_FLAGS = [
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
] as const;

const basename = (filePath: string): string => filePath.split("/").pop() ?? filePath;

const summarizeToolUse = (block: ToolUseBlock): string => {
  const input = block.input;
  switch (block.name) {
    case "Read":
      return `Reading ${basename(String(input.file_path ?? ""))}`;
    case "Write":
      return `Writing ${basename(String(input.file_path ?? ""))}`;
    case "Edit":
      return `Editing ${basename(String(input.file_path ?? ""))}`;
    case "Bash":
      return `Running: ${String(input.command ?? "").slice(0, 40)}`;
    case "Grep":
      return `Searching: ${String(input.pattern ?? "").slice(0, 30)}`;
    case "Glob":
      return `Finding: ${String(input.pattern ?? "").slice(0, 30)}`;
    case "LSP":
      return `LSP: ${String(input.method ?? "")}`;
    case "ExitPlanMode":
      return "Plan ready";
    default:
      return block.name;
  }
};

const parseEvent = (line: string): StreamEvent | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const objectValue = parsed as Record<string, unknown>;
    if (objectValue.type === "assistant") {
      const message = objectValue.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        return null;
      }

      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        return null;
      }

      return parsed as AssistantEvent;
    }

    if (objectValue.type === "result") {
      return parsed as ResultEvent;
    }

    return null;
  } catch {
    return null;
  }
};

const forEachEvent = (
  stdout: Readable,
  onEvent: (event: StreamEvent) => void,
): { readonly flush: () => void } => {
  let buffer = "";

  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseEvent(line);
      if (event) {
        onEvent(event);
      }
    }
  });

  return {
    flush: () => {
      if (!buffer.trim()) {
        return;
      }

      const event = parseEvent(buffer);
      if (event) {
        onEvent(event);
      }
    },
  };
};

const buildClaudeArgs = (
  permissionFlags: readonly string[],
  opts: {
    readonly resumeSessionId?: string;
    readonly systemPrompt?: string;
    readonly model?: string;
    readonly allowResume: boolean;
  },
): readonly string[] => {
  const promptFlags = opts.resumeSessionId && opts.allowResume ? ["--resume", opts.resumeSessionId] : ["-p"];

  return [
    ...permissionFlags,
    ...promptFlags,
    ...CLAUDE_STREAM_FLAGS,
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.systemPrompt ? ["--append-system-prompt", opts.systemPrompt] : []),
  ];
};

export const createClaudeProcess = (
  opts: CreateClaudeProcessOptions,
): ClaudeAgentProcess => {
  const sessionId = opts.sessionId ?? randomUUID();
  let isAlive = true;
  let lastCloseCode = 1;

  const child = spawn(opts.command, [...opts.args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let onEvent: ((event: StreamEvent) => void) | null = null;
  let onDeath: (() => void) | null = null;
  const messageQueue: MessageSource[] = [];

  const { flush } = forEachEvent(child.stdout!, (event) => {
    const source = messageQueue[0];

    if (source === "inject") {
      if (event.type === "result") {
        messageQueue.shift();
      }
      return;
    }

    if (event.type === "result") {
      messageQueue.shift();
    }

    onEvent?.(event);
  });

  child.on("close", (code: number | null) => {
    isAlive = false;
    lastCloseCode = code ?? 1;
    flush();
    messageQueue.length = 0;
    onDeath?.();
  });

  child.on("error", () => {
    isAlive = false;
    messageQueue.length = 0;
    onDeath?.();
  });

  const writeMessage = (prompt: string): void => {
    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
      session_id: sessionId,
    });

    child.stdin!.write(`${message}\n`);
  };

  let persistentOnText: ((text: string) => void) | null = null;
  let persistentOnToolUse: ((summary: string) => void) | null = null;

  const pipe = (onText: (text: string) => void, onToolUse: (summary: string) => void): void => {
    persistentOnText = onText;
    persistentOnToolUse = onToolUse;
  };

  const send = async (
    prompt: string,
    onText?: (text: string) => void,
    onToolUse?: (summary: string) => void,
  ): Promise<AgentResult> =>
    new Promise<AgentResult>((resolve) => {
      if (!isAlive) {
        resolve({ exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId });
        return;
      }

      const assistantChunks: string[] = [];
      let resultText = "";
      let planText: string | undefined;

      onEvent = (event) => {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              assistantChunks.push(block.text);
              (onText ?? persistentOnText)?.(block.text);
              continue;
            }

            if (block.type === "tool_use") {
              if (block.name === "ExitPlanMode" && typeof block.input.plan === "string") {
                planText = block.input.plan;
              }

              (onToolUse ?? persistentOnToolUse)?.(summarizeToolUse(block));
            }
          }
          return;
        }

        resultText = typeof event.result === "string" ? event.result : "";
        onEvent = null;
        onDeath = null;

        if (!onToolUse) {
          persistentOnToolUse?.("");
        }

        const assistantText = assistantChunks.join("");
        resolve({
          exitCode: 0,
          assistantText,
          resultText,
          needsInput: detectQuestion(assistantText),
          sessionId,
          planText,
        });
      };

      onDeath = () => {
        onEvent = null;
        onDeath = null;
        resolve({
          exitCode: lastCloseCode,
          assistantText: assistantChunks.join(""),
          resultText,
          needsInput: false,
          sessionId,
          planText,
        });
      };

      messageQueue.push("send");
      writeMessage(prompt);
    });

  const sendQuiet = async (prompt: string): Promise<string> =>
    new Promise<string>((resolve) => {
      if (!isAlive) {
        resolve("");
        return;
      }

      let resultText = "";

      onEvent = (event) => {
        if (event.type !== "result") {
          return;
        }

        resultText = typeof event.result === "string" ? event.result : "";
        onEvent = null;
        onDeath = null;
        resolve(resultText);
      };

      onDeath = () => {
        onEvent = null;
        onDeath = null;
        resolve(resultText);
      };

      messageQueue.push("send");
      writeMessage(prompt);
    });

  const inject = (message: string): void => {
    if (!isAlive) {
      return;
    }

    messageQueue.push("inject");
    const framed =
      `[ORCHESTRATOR GUIDANCE] The operator has provided the following guidance. ` +
      `You are still operating within an orchestrated TDD workflow — incorporate this guidance ` +
      `into your current task, do not switch to freeform mode.\n\n${message}`;

    writeMessage(framed);
  };

  return {
    send,
    sendQuiet,
    inject,
    kill: () => child.kill("SIGTERM"),
    get alive() {
      return isAlive;
    },
    get stderr() {
      return stderr;
    },
    sessionId,
    style: opts.style,
    pipe,
  } satisfies AgentHandle;
};

export const spawnClaudeAgent = (
  style: AgentStyle,
  systemPrompt?: string,
  resumeSessionId?: string,
  cwd?: string,
  model?: string,
): ClaudeAgentProcess =>
  createClaudeProcess({
    command: "claude",
    args: buildClaudeArgs(["--dangerously-skip-permissions"], {
      resumeSessionId,
      systemPrompt,
      model,
      allowResume: true,
    }),
    style,
    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
    cwd,
  });

export const spawnClaudePlanAgent = (
  style: AgentStyle,
  systemPrompt?: string,
  cwd?: string,
  model?: string,
): ClaudeAgentProcess =>
  createClaudeProcess({
    command: "claude",
    args: buildClaudeArgs(["--permission-mode", "plan"], {
      systemPrompt,
      model,
      allowResume: false,
    }),
    style,
    cwd,
  });
