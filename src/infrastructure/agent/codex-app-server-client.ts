import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  normalizeCodexNotification,
  type CodexEvent,
  type ThreadOptions,
} from "#infrastructure/agent/codex-types.js";

type JsonRpcNotification = {
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type JsonRpcServerRequest = {
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type JsonRpcClient = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  respond(id: number | string, result: unknown): void;
  onNotification(handler: (notification: JsonRpcNotification) => void): void;
  onServerRequest(handler: (request: JsonRpcServerRequest) => void): void;
  close(): void;
};

type PendingRpcRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
};

export type CodexAppServerClient = {
  readonly threadId: string | undefined;
  readonly currentTurnId: string | undefined;
  readonly alive: boolean;
  initialize(): Promise<void>;
  startThread(opts?: ThreadOptions): Promise<string>;
  resumeThread(threadId: string, opts?: ThreadOptions): Promise<string>;
  startTurn(prompt: string, onEvent: (event: CodexEvent) => void): Promise<string>;
  steerTurn(message: string): Promise<void>;
  interruptTurn(): Promise<void>;
  respondToApproval(requestId: string, approved: boolean): void;
  close(): void;
};

const createJsonRpcClient = (proc: ChildProcess): JsonRpcClient => {
  if (!proc.stdin || !proc.stdout) {
    throw new Error('ChildProcess must have stdin and stdout (use stdio: ["pipe", "pipe", ...])');
  }

  const stdin = proc.stdin;
  let nextId = 1;
  const pending = new Map<number, PendingRpcRequest>();
  let notificationHandler: ((notification: JsonRpcNotification) => void) | undefined;
  let serverRequestHandler: ((request: JsonRpcServerRequest) => void) | undefined;

  const readline = createInterface({ input: proc.stdout });

  readline.on("close", () => {
    for (const request of pending.values()) {
      request.reject(new Error("process exited"));
    }
    pending.clear();
  });

  readline.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const hasId = "id" in message && (typeof message.id === "number" || typeof message.id === "string");
    const hasMethod = "method" in message && typeof message.method === "string";

    if (hasId && hasMethod) {
      serverRequestHandler?.({
        id: message.id as number | string,
        method: message.method as string,
        params: message.params as Record<string, unknown> | undefined,
      });
      return;
    }

    if (hasId && typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);

      if (message.error) {
        request.reject(message.error);
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (hasMethod) {
      notificationHandler?.({
        method: message.method as string,
        params: message.params as Record<string, unknown> | undefined,
      });
    }
  });

  return {
    request: async (method, params) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    respond: (id, result) => {
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    },
    onNotification: (handler) => {
      notificationHandler = handler;
    },
    onServerRequest: (handler) => {
      serverRequestHandler = handler;
    },
    close: () => {
      proc.kill();
      for (const request of pending.values()) {
        request.reject(new Error("client closed"));
      }
      pending.clear();
    },
  };
};

const readTurnId = (raw: unknown): string => {
  const result = raw as Record<string, unknown> | undefined;
  const turn = result?.turn;

  if (
    typeof turn === "object" &&
    turn !== null &&
    typeof (turn as Record<string, unknown>).id === "string"
  ) {
    return (turn as Record<string, unknown>).id;
  }

  const turnId = result?.turnId;
  if (typeof turnId === "string") {
    return turnId;
  }

  throw new Error("turn/start response missing turn id");
};

export const createCodexAppServerClient = (proc: ChildProcess): CodexAppServerClient => {
  if (!proc.stdin) {
    throw new Error('ChildProcess must have stdin (use stdio: ["pipe", ...])');
  }

  const stdin = proc.stdin;
  const rpc = createJsonRpcClient(proc);
  let threadId: string | undefined;
  let currentTurnId: string | undefined;
  let alive = true;
  const serverRequestIds = new Map<string, number | string>();
  let rejectActiveTurn: ((error: Error) => void) | null = null;

  const clearTurnHandlers = () => {
    rpc.onNotification(() => {});
    rpc.onServerRequest(() => {});
  };

  const markDead = () => {
    alive = false;
    rejectActiveTurn?.(new Error("process exited"));
  };

  if (typeof proc.on === "function") {
    proc.on("close", markDead);
    proc.on("error", markDead);
  }

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
      stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    },
    startThread: async (opts) => {
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
    resumeThread: async (id, opts) => {
      const params: Record<string, unknown> = { threadId: id };
      if (opts?.developerInstructions) {
        params.developerInstructions = opts.developerInstructions;
      }
      if (opts?.sandbox) {
        params.sandbox = opts.sandbox;
      }

      await rpc.request("thread/resume", params);
      threadId = id;
      return id;
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

      rpc.onNotification((notification) => {
        const event = normalizeCodexNotification(notification);
        if (event.kind === "textDelta") {
          accumulatedText += event.text;
        }
        if (event.kind === "turnCompleted") {
          resolveCompletion?.(accumulatedText);
          return;
        }
        onEvent(event);
      });

      rpc.onServerRequest((request) => {
        const event = normalizeCodexNotification({
          method: request.method,
          params: request.params,
        });
        if (event.kind === "approvalRequested") {
          serverRequestIds.set(event.request.id, request.id);
          onEvent(event);
          return;
        }
        onEvent(event);
      });

      try {
        const result = await rpc.request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
        });
        currentTurnId = readTurnId(result);

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
        rpc.respond(rpcId, { decision: approved ? "accept" : "cancel" });
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
