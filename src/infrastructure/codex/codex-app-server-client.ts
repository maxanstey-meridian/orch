import type { ChildProcess } from "node:child_process";
import { createJsonRpcClient, type JsonRpcClient } from "./codex-json-rpc.js";
import { normalizeNotification, type CodexEvent } from "./codex-notifications.js";

export type ThreadOptions = {
  readonly developerInstructions?: string;
  readonly sandbox?: "read-only" | "workspace-write";
};

export type CodexAppServerClient = {
  readonly threadId: string | undefined;
  readonly currentTurnId: string | undefined;
  readonly alive: boolean;
  initialize(): Promise<void>;
  startThread(opts?: ThreadOptions): Promise<string>;
  resumeThread(threadId: string, opts?: ThreadOptions): Promise<string>;
  startTurn(prompt: string, onEvent: (e: CodexEvent) => void): Promise<string>;
  steerTurn(message: string): Promise<void>;
  interruptTurn(): Promise<void>;
  respondToApproval(requestId: string, approved: boolean): void;
  close(): void;
};

export const createCodexAppServerClient = (proc: ChildProcess): CodexAppServerClient => {
  if (!proc.stdin) {
    throw new Error('ChildProcess must have stdin (use stdio: ["pipe", ...])');
  }
  const stdin = proc.stdin;
  const rpc: JsonRpcClient = createJsonRpcClient(proc);
  let threadId: string | undefined;
  let currentTurnId: string | undefined;
  let alive = true;
  // Maps itemId → raw JSON-RPC request id (preserves number/string type for response)
  const serverRequestIds = new Map<string, number | string>();
  let rejectActiveTurn: ((error: Error) => void) | null = null;

  const clearTurnHandlers = () => {
    rpc.onNotification(() => {});
    rpc.onServerRequest(() => {});
  };

  const readTurnId = (raw: unknown): string => {
    const result = raw as Record<string, unknown> | undefined;
    const turn = result?.turn;

    if (
      typeof turn === "object" &&
      turn !== null &&
      typeof (turn as Record<string, unknown>).id === "string"
    ) {
      return (turn as Record<string, unknown>).id as string;
    }

    if (typeof result?.turnId === "string") {
      return result.turnId;
    }

    throw new Error("turn/start response missing turn id");
  };

  const markDead = () => {
    alive = false;
    rejectActiveTurn?.(new Error("process exited"));
  };
  // Hook process events when available (real ChildProcess)
  if (typeof proc.on === "function") {
    proc.on("close", markDead);
    proc.on("error", markDead);
  }
  // Also catch stdout ending (covers both real processes and PassThrough mocks)
  proc.stdout?.on("end", markDead);
  proc.stdout?.on("close", markDead);

  return {
    get threadId() {
      return threadId;
    },
    get currentTurnId() {
      return currentTurnId;
    },
    get alive() {
      return alive;
    },

    initialize: async () => {
      await rpc.request("initialize", { clientInfo: { name: "orch", version: "0.1.0" } });
      // Send initialized notification (no id)
      if (stdin.writableEnded || stdin.destroyed) {
        return;
      }
      try {
        stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      } catch {
        // The child can die between initialize resolving and the notification write.
      }
    },

    startThread: async (opts?) => {
      const params: Record<string, unknown> = {};
      if (opts?.developerInstructions) {
        params.developerInstructions = opts.developerInstructions;
      }
      if (opts?.sandbox) {
        params.sandbox = opts.sandbox;
      }
      const raw = await rpc.request("thread/start", params);
      const result = raw as Record<string, unknown> | undefined;
      const thread = result?.thread;
      if (typeof thread === "object" && thread !== null && "id" in thread) {
        threadId = String((thread as Record<string, unknown>).id);
      } else if (typeof result?.threadId === "string") {
        threadId = result.threadId;
      } else {
        threadId = "";
      }
      return threadId;
    },

    resumeThread: async (tid, opts?) => {
      const params: Record<string, unknown> = { threadId: tid };
      if (opts?.developerInstructions) {
        params.developerInstructions = opts.developerInstructions;
      }
      if (opts?.sandbox) {
        params.sandbox = opts.sandbox;
      }
      await rpc.request("thread/resume", params);
      threadId = tid;
      return tid;
    },

    startTurn: async (prompt, onEvent) => {
      let accumulatedText = "";
      let resolveCompletion: ((text: string) => void) | null = null;
      let settled = false;

      const completionPromise = new Promise<string>((resolve, reject) => {
        resolveCompletion = (text: string) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(text);
        };
        rejectActiveTurn = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };
      });
      completionPromise.catch(() => {});

      const turnHandler = (n: { method: string; params?: Record<string, unknown> }) => {
        const event = normalizeNotification(n);
        if (event.kind === "textDelta") {
          accumulatedText += event.text;
        }
        if (event.kind === "turnCompleted") {
          // Use accumulated text from deltas — the notification itself has no result text
          resolveCompletion?.(accumulatedText);
          return;
        }
        // turnFailed is passed through to onEvent — send() handles it via the failed flag
        onEvent(event);
      };
      rpc.onNotification(turnHandler);
      rpc.onServerRequest((r) => {
        const event = normalizeNotification({ method: r.method, params: r.params });
        if (event.kind === "approvalRequested") {
          // Store the raw JSON-RPC id (preserve type — number or string) for the response
          serverRequestIds.set(event.request.id, r.id);
          onEvent(event);
        } else {
          onEvent(event);
        }
      });

      const params: Record<string, unknown> = {
        threadId,
        input: [{ type: "text", text: prompt }],
      };

      try {
        // turn/start returns immediately with an ack — the real result comes via turn/completed notification
        const startResult = await rpc.request("turn/start", params);
        currentTurnId = readTurnId(startResult);

        const resultText = await completionPromise;
        onEvent({ kind: "turnCompleted", resultText });
        return resultText;
      } finally {
        rejectActiveTurn = null;
        currentTurnId = undefined;
        clearTurnHandlers();
      }
    },

    steerTurn: async (message) => {
      if (!currentTurnId) {
        throw new Error("No active turn to steer");
      }
      await rpc.request("turn/steer", { threadId, turnId: currentTurnId, message });
    },

    interruptTurn: async () => {
      if (!currentTurnId) {
        throw new Error("No active turn to interrupt");
      }
      await rpc.request("turn/interrupt", { threadId, turnId: currentTurnId });
    },

    respondToApproval: (requestId, approved) => {
      const rpcId = serverRequestIds.get(requestId);

      if (rpcId !== undefined) {
        serverRequestIds.delete(requestId);
        const decision = approved ? "accept" : "cancel";
        rpc.respond(rpcId, { decision });
        return;
      }

      stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "codex/approvalResponse",
          params: { id: requestId, approved },
        }) + "\n",
      );
    },

    close: () => {
      alive = false;
      rejectActiveTurn?.(new Error("client closed"));
      rejectActiveTurn = null;
      rpc.close();
    },
  };
};
