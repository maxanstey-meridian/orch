import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type JsonRpcNotification = {
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

export type JsonRpcServerRequest = {
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

export type JsonRpcClient = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  respond(id: number | string, result: unknown): void;
  onNotification(handler: (n: JsonRpcNotification) => void): void;
  onServerRequest(handler: (r: JsonRpcServerRequest) => void): void;
  close(): void;
};

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
};

const createJsonRpcError = (
  error: Record<string, unknown>,
): Error & { readonly code?: unknown; readonly data?: unknown } => {
  const message =
    typeof error.message === "string" ? error.message : "unknown JSON-RPC error";
  const enriched = new Error(message) as Error & {
    readonly code?: unknown;
    readonly data?: unknown;
  };
  if ("code" in error) {
    Object.assign(enriched, { code: error.code });
  }
  if ("data" in error) {
    Object.assign(enriched, { data: error.data });
  }
  return enriched;
};

export const createJsonRpcClient = (proc: ChildProcess): JsonRpcClient => {
  if (!proc.stdin || !proc.stdout) {
    throw new Error('ChildProcess must have stdin and stdout (use stdio: ["pipe", "pipe", ...])');
  }
  const stdin = proc.stdin;

  let nextId = 1;
  const pending = new Map<number, Pending>();
  let notificationHandler: ((n: JsonRpcNotification) => void) | undefined;
  let serverRequestHandler: ((r: JsonRpcServerRequest) => void) | undefined;

  const rl = createInterface({ input: proc.stdout });

  rl.on("close", () => {
    for (const entry of pending.values()) {
      entry.reject(new Error("process exited"));
    }
    pending.clear();
  });

  rl.on("line", (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.warn("JSON-RPC: failed to parse line:", line);
      return;
    }

    const hasId = "id" in msg && (typeof msg.id === "number" || typeof msg.id === "string");
    const hasMethod = "method" in msg && typeof msg.method === "string";

    if (hasId && hasMethod) {
      // Server-initiated request (has both id and method) — e.g. approval requests
      serverRequestHandler?.({
        id: msg.id as number | string,
        method: msg.method as string,
        params: msg.params as Record<string, unknown> | undefined,
      });
    } else if (hasId && typeof msg.id === "number") {
      // Response to our request
      const entry = pending.get(msg.id);
      if (!entry) {
        return;
      }
      pending.delete(msg.id);

      if (msg.error) {
        if (msg.error && typeof msg.error === "object" && !Array.isArray(msg.error)) {
          const err = msg.error as Record<string, unknown>;
          entry.reject(createJsonRpcError(err));
        } else {
          entry.reject(new Error(String(msg.error ?? "unknown JSON-RPC error")));
        }
      } else {
        entry.resolve(msg.result);
      }
    } else if (hasMethod) {
      // Notification (method only, no id)
      notificationHandler?.({
        method: msg.method as string,
        params: msg.params as Record<string, unknown> | undefined,
      });
    }
  });

  return {
    request: (method, params) => {
      const id = nextId++;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      if (stdin.writableEnded || stdin.destroyed) {
        const entry = pending.get(id);
        pending.delete(id);
        entry?.reject(new Error("process exited"));
        return promise;
      }
      try {
        stdin.write(message);
      } catch {
        const entry = pending.get(id);
        pending.delete(id);
        entry?.reject(new Error("process exited"));
      }
      return promise;
    },

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
      for (const entry of pending.values()) {
        entry.reject(new Error("client closed"));
      }
      pending.clear();
    },
  };
};
