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

export type FakeAppServer = {
  readonly proc: ChildProcess;
  readonly receivedRequests: ReceivedRequest[];
  readonly stdout: PassThrough;
  setTurnScript(events: TurnScript): void;
  close(): void;
};

export const createFakeAppServer = (): FakeAppServer => {
  const clientStdin = new PassThrough();
  const clientStdout = new PassThrough();
  const kill = vi.fn();

  const proc = { stdin: clientStdin, stdout: clientStdout, kill } as unknown as ChildProcess;

  const receivedRequests: ReceivedRequest[] = [];
  let turnScript: TurnScript = [];

  const rl = createInterface({ input: clientStdin });

  const sendResponse = (id: number, result: unknown) => {
    clientStdout.push(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };

  const sendNotification = (method: string, params?: Record<string, unknown>) => {
    clientStdout.push(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  const eventToNotification = (event: CodexEvent): { method: string; params?: Record<string, unknown> } => {
    switch (event.kind) {
      case 'textDelta':
        return { method: 'item/agentMessage/delta', params: { text: event.text } };
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
        return { method: 'error', params: { code: event.error.code, message: event.error.message } };
      case 'approvalRequested':
        return { method: 'codex/approvalRequest', params: { id: event.request.id, kind: event.request.kind, summary: event.request.summary } };
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

    const id = msg.id as number;
    const method = msg.method as string;
    const params = msg.params as Record<string, unknown> | undefined;

    // Only record requests (have id), not notifications
    if (typeof id === 'number') {
      receivedRequests.push({ id, method, params });
    }

    switch (method) {
      case 'initialize':
        sendResponse(id, { capabilities: {} });
        break;
      case 'thread/start':
        sendResponse(id, { threadId: `thread-${Date.now()}` });
        break;
      case 'thread/resume':
        sendResponse(id, { threadId: params?.threadId ?? 'resumed-thread' });
        break;
      case 'turn/start': {
        // Emit scripted events, then respond
        for (const event of turnScript) {
          const notif = eventToNotification(event);
          if (event.kind === 'turnCompleted') {
            // turnCompleted is the RPC response, not a notification
            sendResponse(id, { result: event.resultText });
          } else {
            sendNotification(notif.method, notif.params);
          }
        }
        // If no turnCompleted in the script, still respond
        if (!turnScript.some((e) => e.kind === 'turnCompleted')) {
          sendResponse(id, { result: '' });
        }
        break;
      }
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
    stdout: clientStdout,
    setTurnScript: (events) => { turnScript = events; },
    close: () => {
      rl.close();
      clientStdin.end();
      clientStdout.end();
    },
  };
};
