import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSpawner, type AgentHandle } from "#application/ports/agent-spawner.port.js";
import {
  RuntimeInteractionGate,
  type RuntimeInteractionDecision,
  type RuntimeInteractionRequest,
} from "#application/ports/runtime-interaction.port.js";
import { CodexAgentSpawner } from "#infrastructure/agent/codex-agent-spawner.js";
import { createCodexAppServerClient } from "#infrastructure/agent/codex-app-server-client.js";
import type { CodexEvent } from "#infrastructure/agent/codex-types.js";

const tick = async () => new Promise((resolve) => setTimeout(resolve, 10));

type ReceivedRequest = {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type ReceivedNotification = {
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type ReceivedResponse = {
  readonly id: number | string;
  readonly result?: unknown;
};

type FakeAppServer = {
  readonly proc: ChildProcess;
  readonly receivedRequests: ReceivedRequest[];
  readonly receivedNotifications: ReceivedNotification[];
  readonly receivedResponses: ReceivedResponse[];
  readonly lastTurnId: string | undefined;
  readonly stdout: PassThrough;
  setTurnScript(events: readonly CodexEvent[]): void;
  hangOnTurn(): void;
  stallTurnAfterStart(): void;
  close(): void;
};

class FakeRuntimeInteractionGate extends RuntimeInteractionGate {
  readonly requests: RuntimeInteractionRequest[] = [];
  private decisions: Array<RuntimeInteractionDecision | (() => RuntimeInteractionDecision)> = [];

  queueDecision(
    ...decisions: Array<RuntimeInteractionDecision | (() => RuntimeInteractionDecision)>
  ): void {
    this.decisions.push(...decisions);
  }

  async decide(request: RuntimeInteractionRequest): Promise<RuntimeInteractionDecision> {
    this.requests.push(request);
    const next = this.decisions.shift();
    if (!next) {
      throw new Error("FakeRuntimeInteractionGate: no decision queued");
    }
    return typeof next === "function" ? next() : next;
  }
}

const createFakeAppServer = (): FakeAppServer => {
  const clientStdin = new PassThrough();
  const clientStdout = new PassThrough();
  const kill = vi.fn();

  const proc = {
    stdin: clientStdin,
    stdout: clientStdout,
    kill,
  } as unknown as ChildProcess;

  const receivedRequests: ReceivedRequest[] = [];
  const receivedNotifications: ReceivedNotification[] = [];
  const receivedResponses: ReceivedResponse[] = [];
  let turnScript: readonly CodexEvent[] = [];
  let shouldHangOnTurn = false;
  let shouldStallTurnAfterStart = false;
  let nextTurnId = 1;
  let activeTurnId: string | undefined;
  let lastTurnId: string | undefined;
  let nextServerRequestId = 1000;

  const sendResponse = (id: number, result: unknown) => {
    clientStdout.push(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  };

  const sendError = (id: number, message: string) => {
    clientStdout.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      }) + "\n",
    );
  };

  const sendNotification = (method: string, params?: Record<string, unknown>) => {
    clientStdout.push(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  const sendServerRequest = (method: string, params?: Record<string, unknown>) => {
    clientStdout.push(
      JSON.stringify({ jsonrpc: "2.0", id: nextServerRequestId++, method, params }) + "\n",
    );
  };

  const eventToNotification = (
    event: CodexEvent,
  ): { readonly method: string; readonly params?: Record<string, unknown> } => {
    switch (event.kind) {
      case "textDelta":
        return { method: "item/agentMessage/delta", params: { delta: event.text } };
      case "toolActivity":
        if (event.summary.startsWith("command: ")) {
          return {
            method: "item/completed",
            params: { commandExecution: { command: event.summary.slice("command: ".length) } },
          };
        }
        if (event.summary.startsWith("file change: ")) {
          return {
            method: "item/completed",
            params: { fileChange: { path: event.summary.slice("file change: ".length) } },
          };
        }
        if (event.summary.startsWith("mcp tool: ")) {
          return {
            method: "item/completed",
            params: { mcpToolCall: { name: event.summary.slice("mcp tool: ".length) } },
          };
        }
        return {
          method: "item/completed",
          params: { commandExecution: { command: event.summary } },
        };
      case "turnCompleted":
        return { method: "turn/completed", params: { result: event.resultText } };
      case "turnFailed":
        return {
          method: "error",
          params: { error: { message: event.message, codexErrorInfo: "unknown" }, willRetry: false },
        };
      case "approvalRequested":
        return {
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: event.request.id,
            reason: event.request.summary,
            command: event.request.summary,
          },
        };
      case "ignored":
        return { method: "ignored" };
    }
  };

  const readline = createInterface({ input: clientStdin });

  readline.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;
    const params = message.params as Record<string, unknown> | undefined;

    if (id != null && !method) {
      receivedResponses.push({ id, result: message.result });
    } else if (id != null && method) {
      receivedRequests.push({ id: id as number, method, params });
    } else if (method) {
      receivedNotifications.push({ method, params });
    }

    switch (method) {
      case "initialize":
        sendResponse(id as number, { capabilities: {} });
        break;
      case "thread/start":
        sendResponse(id as number, { thread: { id: `thread-${Date.now()}` } });
        break;
      case "thread/resume":
        sendResponse(id as number, { threadId: params?.threadId ?? "resumed-thread" });
        break;
      case "turn/start": {
        if (shouldHangOnTurn) {
          break;
        }
        const turnId = `turn-${nextTurnId++}`;
        activeTurnId = turnId;
        lastTurnId = turnId;
        sendResponse(id as number, { turn: { id: turnId, status: "inProgress" } });
        if (shouldStallTurnAfterStart) {
          break;
        }
        for (const event of turnScript) {
          const notification = eventToNotification(event);
          if (event.kind === "approvalRequested") {
            sendServerRequest(notification.method, notification.params);
          } else {
            sendNotification(notification.method, notification.params);
          }
        }
        if (!turnScript.some((event) => event.kind === "turnCompleted")) {
          sendNotification("turn/completed", { turn: { status: "completed" } });
        }
        activeTurnId = undefined;
        shouldStallTurnAfterStart = false;
        break;
      }
      case "turn/steer":
        if (params?.turnId !== activeTurnId) {
          sendError(id as number, `unknown turn ${String(params?.turnId ?? "")}`);
          break;
        }
        sendResponse(id as number, {});
        break;
      case "turn/interrupt":
        if (params?.turnId !== activeTurnId) {
          sendError(id as number, `unknown turn ${String(params?.turnId ?? "")}`);
          break;
        }
        activeTurnId = undefined;
        sendResponse(id as number, {});
        break;
      default:
        if (typeof id === "number") {
          sendResponse(id, {});
        }
        break;
    }
  });

  return {
    proc,
    receivedRequests,
    receivedNotifications,
    receivedResponses,
    get lastTurnId() {
      return lastTurnId;
    },
    stdout: clientStdout,
    setTurnScript: (events) => {
      turnScript = events;
    },
    hangOnTurn: () => {
      shouldHangOnTurn = true;
    },
    stallTurnAfterStart: () => {
      shouldStallTurnAfterStart = true;
    },
    close: () => {
      readline.close();
      clientStdin.end();
      clientStdout.end();
    },
  };
};

const extractTurnPrompt = (params?: Record<string, unknown>): string => {
  const input = params?.input as ReadonlyArray<{ text: string }> | undefined;
  return input?.[0]?.text ?? "";
};

describe("CodexAgentSpawner", () => {
  let fake: FakeAppServer | undefined;

  afterEach(() => {
    fake?.close();
    fake = undefined;
  });

  it.each(["plan", "gap", "completeness", "triage"] as const)(
    "spawns %s with read-only sandbox",
    async (role) => {
      fake = createFakeAppServer();
      const gate = new FakeRuntimeInteractionGate();
      const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
      const handle = spawner.spawn(role);

      fake.setTurnScript([{ kind: "turnCompleted", resultText: "" }]);
      await handle.send("init");

      const threadStart = fake.receivedRequests.find((request) => request.method === "thread/start");
      expect(threadStart?.params?.sandbox).toBe("read-only");
    },
  );

  it("spawns tdd with workspace-write sandbox", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");

    fake.setTurnScript([{ kind: "turnCompleted", resultText: "" }]);
    await handle.send("init");

    const threadStart = fake.receivedRequests.find((request) => request.method === "thread/start");
    expect(threadStart?.params?.sandbox).toBe("workspace-write");
    expect(handle.stderr).toBe("");
  });

  it("routes approval requests through the gate in interactive mode", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    gate.queueDecision({ kind: "approve" });
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");

    fake.setTurnScript([
      {
        kind: "approvalRequested",
        request: { id: "approval-1", kind: "command", summary: "npm test" },
      },
      { kind: "turnCompleted", resultText: "" },
    ]);

    await handle.send("go");
    await tick();

    expect(gate.requests).toEqual([
      { kind: "commandApproval", summary: "npm test", command: "npm test" },
    ]);
    expect(fake.receivedResponses).toContainEqual({
      id: 1000,
      result: { decision: "accept" },
    });
  });

  it("auto-approves approval requests when auto mode is enabled", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: true }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");

    fake.setTurnScript([
      {
        kind: "approvalRequested",
        request: { id: "approval-1", kind: "command", summary: "npm test" },
      },
      { kind: "turnCompleted", resultText: "" },
    ]);

    await handle.send("go");
    await tick();

    expect(gate.requests).toEqual([]);
    expect(fake.receivedResponses).toContainEqual({
      id: 1000,
      result: { decision: "accept" },
    });
  });

  it("buffers text until a sentence boundary before flushing", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");
    const onText = vi.fn();

    fake.setTurnScript([
      { kind: "textDelta", text: "Hello" },
      { kind: "textDelta", text: " world." },
      { kind: "turnCompleted", resultText: "" },
    ]);

    await handle.send("go", onText);

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Hello world.");
  });

  it("trims synthetic leading whitespace after a sentence-boundary flush", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");
    const onText = vi.fn();

    fake.setTurnScript([
      { kind: "textDelta", text: "First sentence." },
      { kind: "textDelta", text: " Second sentence." },
      { kind: "turnCompleted", resultText: "" },
    ]);

    await handle.send("go", onText);

    expect(onText).toHaveBeenNthCalledWith(1, "First sentence.");
    expect(onText).toHaveBeenNthCalledWith(2, "Second sentence.");
  });

  it("queues pending guidance and prepends it to the next turn prompt", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");

    handle.inject("fix the tests");
    fake.setTurnScript([{ kind: "turnCompleted", resultText: "" }]);

    await handle.send("run the slice");

    const turnStart = fake.receivedRequests.find((request) => request.method === "turn/start");
    expect(extractTurnPrompt(turnStart?.params)).toContain("fix the tests");
    expect(extractTurnPrompt(turnStart?.params)).toContain("run the slice");
  });

  it("resumes a session by thread id instead of starting a new thread", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd", { resumeSessionId: "thread-123" });

    fake.setTurnScript([{ kind: "turnCompleted", resultText: "" }]);
    await handle.send("resume");

    expect(fake.receivedRequests.some((request) => request.method === "thread/start")).toBe(false);
    expect(fake.receivedRequests.some((request) => request.method === "thread/resume")).toBe(true);
    expect(handle.sessionId).toBe("thread-123");
  });

  it("exposes currentTurnId only while a turn is active", async () => {
    fake = createFakeAppServer();
    fake.stallTurnAfterStart();
    const client = createCodexAppServerClient(fake.proc);

    await client.initialize();
    await client.startThread();

    expect(client.currentTurnId).toBeUndefined();

    const turnPromise = client.startTurn("go", () => {}).catch(() => {});
    await tick();

    expect(client.currentTurnId).toBe(fake.lastTurnId);

    fake.close();
    await turnPromise;

    expect(client.currentTurnId).toBeUndefined();
  });

  it("returns exitCode 1 when the process dies mid-turn", async () => {
    fake = createFakeAppServer();
    fake.hangOnTurn();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");

    await tick();

    const resultPromise = handle.send("will die");
    await tick();
    fake.stdout.push(null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 1,
      assistantText: "",
      resultText: "",
      needsInput: false,
      sessionId: handle.sessionId,
    });
  });

  it("sendQuiet rejects when the process dies before the turn completes", async () => {
    fake = createFakeAppServer();
    fake.hangOnTurn();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");

    await tick();

    const resultPromise = handle.sendQuiet("rules reminder");
    await tick();
    fake.stdout.push(null);

    await expect(resultPromise).rejects.toThrow(/process exited/i);
  });

  it("sendQuiet rejects when the turn reports a failure", async () => {
    fake = createFakeAppServer();
    const gate = new FakeRuntimeInteractionGate();
    const spawner = new CodexAgentSpawner("/tmp/test", { auto: false }, () => fake!.proc, gate);
    const handle = spawner.spawn("tdd");

    fake.setTurnScript([
      { kind: "turnFailed", message: "rules reminder failed" },
      { kind: "turnCompleted", resultText: "" },
    ]);

    await expect(handle.sendQuiet("rules reminder")).rejects.toThrow("rules reminder failed");
  });

  it("satisfies the AgentSpawner port surface", () => {
    class TestSpawner extends AgentSpawner {
      override spawn(): AgentHandle {
        throw new Error("not used");
      }
    }

    expect(new TestSpawner()).toBeInstanceOf(AgentSpawner);
  });
});
