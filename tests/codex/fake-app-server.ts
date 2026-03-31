import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexEvent } from '../../src/infrastructure/codex/codex-notifications.js';

type ReceivedRequest = {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type TurnScript = ReadonlyArray<CodexEvent>;

type ReceivedNotification = {
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type ReceivedResponse = {
  readonly id: number | string;
  readonly result?: unknown;
};

export type FakeAppServer = {
  readonly proc: ChildProcess;
  readonly receivedRequests: ReceivedRequest[];
  readonly receivedNotifications: ReceivedNotification[];
  readonly receivedResponses: ReceivedResponse[];
  readonly lastTurnId: string | undefined;
  readonly stdout: PassThrough;
  setTurnScript(events: TurnScript): void;
  hangOnTurn(): void;
  stallTurnAfterStart(): void;
  close(): void;
};

export const createFakeAppServer = (): FakeAppServer => {
  const clientStdin = new PassThrough();
  const clientStdout = new PassThrough();
  const kill = vi.fn();

  const proc = { stdin: clientStdin, stdout: clientStdout, kill } as unknown as ChildProcess;

  const receivedRequests: ReceivedRequest[] = [];
  const receivedNotifications: ReceivedNotification[] = [];
  const receivedResponses: ReceivedResponse[] = [];
  let turnScript: TurnScript = [];
  let shouldHangOnTurn = false;
  let shouldStallTurnAfterStart = false;
  let nextTurnId = 1;
  let activeTurnId: string | undefined;
  let lastTurnId: string | undefined;

  const rl = createInterface({ input: clientStdin });

  const sendResponse = (id: number, result: unknown) => {
    clientStdout.push(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };

  const sendError = (id: number, message: string) => {
    clientStdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message },
    }) + '\n');
  };

  let nextServerRequestId = 1000;

  const sendNotification = (method: string, params?: Record<string, unknown>) => {
    clientStdout.push(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  const sendServerRequest = (method: string, params?: Record<string, unknown>) => {
    const id = nextServerRequestId++;
    clientStdout.push(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  };

  const eventToNotification = (event: CodexEvent): { method: string; params?: Record<string, unknown> } => {
    switch (event.kind) {
      case 'textDelta':
        return { method: 'item/agentMessage/delta', params: { delta: event.text } };
      case 'toolActivity':
        // Strip the prefix that normalizeNotification adds (e.g. "command: ") so it round-trips cleanly
        if (event.summary.startsWith('command: ')) {
          return { method: 'item/completed', params: { commandExecution: { command: event.summary.slice('command: '.length) } } };
        }
        if (event.summary.startsWith('file change: ')) {
          return { method: 'item/completed', params: { fileChange: { path: event.summary.slice('file change: '.length) } } };
        }
        if (event.summary.startsWith('mcp tool: ')) {
          return { method: 'item/completed', params: { mcpToolCall: { name: event.summary.slice('mcp tool: '.length) } } };
        }
        return { method: 'item/completed', params: { commandExecution: { command: event.summary } } };
      case 'turnCompleted':
        return { method: 'turn/completed', params: { result: event.resultText } };
      case 'turnFailed':
        return { method: 'error', params: { error: { message: event.message, codexErrorInfo: 'unknown' }, willRetry: false } };
      case 'approvalRequested':
        return { method: 'item/commandExecution/requestApproval', params: { itemId: event.request.id, reason: event.request.summary, command: event.request.summary } };
      case 'ignored':
        return { method: 'some/unknown' };
    }
  };

  rl.on('line', (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = msg.id as number | string | undefined;
    const method = msg.method as string | undefined;
    const params = msg.params as Record<string, unknown> | undefined;

    if (id != null && !method) {
      // Client response to our server request
      receivedResponses.push({ id, result: msg.result });
    } else if (id != null && method) {
      receivedRequests.push({ id: id as number, method, params });
    } else if (method) {
      receivedNotifications.push({ method, params });
    }

    switch (method) {
      case 'initialize':
        sendResponse(id, { capabilities: {} });
        break;
      case 'thread/start':
        sendResponse(id, { thread: { id: `thread-${Date.now()}` } });
        break;
      case 'thread/resume':
        sendResponse(id, { threadId: params?.threadId ?? 'resumed-thread' });
        break;
      case 'turn/start': {
        // If hanging, don't respond at all (simulates process death mid-turn)
        if (shouldHangOnTurn) break;
        const turnId = `turn-${nextTurnId++}`;
        activeTurnId = turnId;
        lastTurnId = turnId;
        // Immediate ack with inProgress status (matches real Codex)
        sendResponse(id, { turn: { id: turnId, status: 'inProgress' } });
        if (shouldStallTurnAfterStart) break;
        // Emit scripted events — approvals as server requests, rest as notifications
        for (const event of turnScript) {
          const notif = eventToNotification(event);
          if (event.kind === 'approvalRequested') {
            sendServerRequest(notif.method, notif.params);
          } else {
            sendNotification(notif.method, notif.params);
          }
        }
        // If no turnCompleted in the script, send one
        if (!turnScript.some((e) => e.kind === 'turnCompleted')) {
          sendNotification('turn/completed', { turn: { status: 'completed' } });
        }
        activeTurnId = undefined;
        shouldStallTurnAfterStart = false;
        break;
      }
      case 'turn/steer':
        if (params?.turnId !== activeTurnId) {
          sendError(id as number, `unknown turn ${String(params?.turnId ?? '')}`);
          break;
        }
        sendResponse(id as number, {});
        break;
      case 'turn/interrupt':
        if (params?.turnId !== activeTurnId) {
          sendError(id as number, `unknown turn ${String(params?.turnId ?? '')}`);
          break;
        }
        activeTurnId = undefined;
        sendResponse(id as number, {});
        break;
      default:
        // Unknown methods get an empty response for requests
        if (typeof id === 'number') {
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
    setTurnScript: (events) => { turnScript = events; },
    hangOnTurn: () => { shouldHangOnTurn = true; },
    stallTurnAfterStart: () => { shouldStallTurnAfterStart = true; },
    close: () => {
      rl.close();
      clientStdin.end();
      clientStdout.end();
    },
  };
};
