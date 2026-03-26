import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { detectQuestion } from "./question-detector.js";

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
};

type AssistantEvent = {
  readonly type: "assistant";
  readonly message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  };
};

type ResultEvent = {
  readonly type: "result";
  readonly result: string;
  readonly duration_ms: number;
  readonly num_turns: number;
};

type StreamEvent = AssistantEvent | ResultEvent;

const parseEvent = (line: string): StreamEvent | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    if (obj.type === "assistant") {
      const msg = obj.message;
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
      const content = (msg as Record<string, unknown>).content;
      if (!Array.isArray(content)) return null;
      return parsed as StreamEvent;
    }

    if (obj.type === "result") return parsed as StreamEvent;

    return null;
  } catch {
    return null;
  }
};

const forEachEvent = (
  stdout: Readable,
  onEvent: (event: StreamEvent) => void,
): { flush: () => void } => {
  let buffer = "";

  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseEvent(line);
      if (event) onEvent(event);
    }
  });

  return {
    flush: () => {
      if (buffer.trim()) {
        const event = parseEvent(buffer);
        if (event) onEvent(event);
      }
    },
  };
};

export type AgentProcess = {
  readonly send: (prompt: string, onText?: (text: string) => void) => Promise<AgentResult>;
  readonly sendQuiet: (prompt: string) => Promise<string>;
  readonly inject: (message: string) => void;
  readonly kill: () => void;
  readonly alive: boolean;
  readonly sessionId: string;
  readonly style: AgentStyle;
  readonly stderr: string;
};

export type CreateAgentOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly style: AgentStyle;
  readonly sessionId?: string;
};

export const createAgent = (opts: CreateAgentOptions): AgentProcess => {
  const sessionId = opts.sessionId ?? randomUUID();
  let isAlive = true;
  let lastCloseCode = 1;

  const proc = spawn(opts.command, [...opts.args], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  let onEvent: ((event: StreamEvent) => void) | null = null;
  let onDeath: (() => void) | null = null;

  // Message queue tracks the FIFO order of send/inject writes to stdin.
  // The child processes messages sequentially, so events arrive in the same order.
  // The queue head tells us whose turn it is: "send" events pass to onEvent,
  // "inject" events are silently discarded. A result event ends each turn.
  const messageQueue: Array<"send" | "inject"> = [];

  const { flush } = forEachEvent(proc.stdout!, (event) => {
    const source = messageQueue[0];

    if (source === "inject") {
      if (event.type === "result") messageQueue.shift();
      return;
    }

    if (event.type === "result") messageQueue.shift();
    if (onEvent) onEvent(event);
  });

  proc.on("close", (code: number | null) => {
    isAlive = false;
    lastCloseCode = code ?? 1;
    flush();
    messageQueue.length = 0;
    if (onDeath) onDeath();
  });

  proc.on("error", () => {
    isAlive = false;
    messageQueue.length = 0;
    if (onDeath) onDeath();
  });

  const writeMessage = (prompt: string) => {
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
      session_id: sessionId,
    });
    proc.stdin!.write(msg + "\n");
  };

  const send = (prompt: string, onText?: (text: string) => void): Promise<AgentResult> => {
    return new Promise<AgentResult>((resolve) => {
      if (!isAlive) {
        resolve({ exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId });
        return;
      }

      const assistantChunks: string[] = [];
      let resultText = "";

      onEvent = (event) => {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              assistantChunks.push(block.text);
              if (onText) onText(block.text);
            }
          }
        } else if (event.type === "result") {
          resultText = typeof event.result === "string" ? event.result : "";
          onEvent = null;
          onDeath = null;
          const assistantText = assistantChunks.join("");
          resolve({
            exitCode: 0,
            assistantText,
            resultText,
            needsInput: detectQuestion(assistantText),
            sessionId,
          });
        }
      };

      onDeath = () => {
        onEvent = null;
        onDeath = null;
        const assistantText = assistantChunks.join("");
        resolve({
          exitCode: lastCloseCode,
          assistantText,
          resultText,
          needsInput: false,
          sessionId,
        });
      };

      messageQueue.push("send");
      writeMessage(prompt);
    });
  };

  const sendQuiet = (prompt: string): Promise<string> => {
    return new Promise<string>((resolve) => {
      if (!isAlive) {
        resolve("");
        return;
      }

      let resultText = "";

      onEvent = (event) => {
        if (event.type === "result") {
          resultText = typeof event.result === "string" ? event.result : "";
          onEvent = null;
          onDeath = null;
          resolve(resultText);
        }
      };

      onDeath = () => {
        onEvent = null;
        onDeath = null;
        resolve(resultText);
      };

      messageQueue.push("send");
      writeMessage(prompt);
    });
  };

  const inject = (message: string): void => {
    if (!isAlive) return;
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
    kill: () => proc.kill("SIGTERM"),
    get alive() {
      return isAlive;
    },
    get stderr() {
      return stderrBuf;
    },
    sessionId,
    style: opts.style,
  };
};
