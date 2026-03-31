import type { ChildProcess } from 'node:child_process';
import { createJsonRpcClient, type JsonRpcClient } from './codex-json-rpc.js';
import { normalizeNotification, type CodexEvent } from './codex-notifications.js';

export type CodexAppServerClient = {
  readonly threadId: string | undefined;
  readonly currentTurnId: string | undefined;
  readonly alive: boolean;
  initialize(): Promise<void>;
  startThread(developerInstructions?: string): Promise<string>;
  resumeThread(threadId: string, developerInstructions?: string): Promise<string>;
  startTurn(prompt: string, onEvent: (e: CodexEvent) => void): Promise<string>;
  steerTurn(message: string): Promise<void>;
  interruptTurn(): Promise<void>;
  close(): void;
};

export const createCodexAppServerClient = (proc: ChildProcess): CodexAppServerClient => {
  const rpc: JsonRpcClient = createJsonRpcClient(proc);
  let threadId: string | undefined;
  let currentTurnId: string | undefined;
  let nextTurnSeq = 1;
  let alive = true;

  const markDead = () => { alive = false; };
  // Hook process events when available (real ChildProcess)
  if (typeof proc.on === 'function') {
    proc.on('close', markDead);
    proc.on('error', markDead);
  }
  // Also catch stdout ending (covers both real processes and PassThrough mocks)
  proc.stdout?.on('end', markDead);
  proc.stdout?.on('close', markDead);

  return {
    get threadId() { return threadId; },
    get currentTurnId() { return currentTurnId; },
    get alive() { return alive; },

    initialize: async () => {
      await rpc.request('initialize', {});
      // Send initialized notification (no id)
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    },

    startThread: async (developerInstructions?) => {
      const params: Record<string, unknown> = {};
      if (developerInstructions) {
        params.developerInstructions = developerInstructions;
      }
      const result = await rpc.request('thread/start', params) as { threadId: string };
      threadId = result.threadId;
      return threadId;
    },

    resumeThread: async (tid, developerInstructions?) => {
      const params: Record<string, unknown> = { threadId: tid };
      if (developerInstructions) {
        params.developerInstructions = developerInstructions;
      }
      await rpc.request('thread/resume', params);
      threadId = tid;
      return tid;
    },

    startTurn: async (prompt, onEvent) => {
      const turnHandler = (n: { method: string; params?: Record<string, unknown> }) => {
        const event = normalizeNotification(n);
        // Skip turnCompleted from notifications — the canonical source is the RPC response
        if (event.kind === 'turnCompleted') return;
        onEvent(event);
      };
      rpc.onNotification(turnHandler);

      currentTurnId = `turn-${nextTurnSeq++}`;
      const params: Record<string, unknown> = { threadId, prompt };
      const result = await rpc.request('turn/start', params) as { result?: string };
      currentTurnId = undefined;
      rpc.onNotification(() => {}); // clear stale handler

      const resultText = typeof result?.result === 'string' ? result.result : String(result?.result ?? '');
      onEvent({ kind: 'turnCompleted', resultText });

      return resultText;
    },

    steerTurn: async (message) => {
      if (!currentTurnId) throw new Error('No active turn to steer');
      await rpc.request('turn/steer', { threadId, turnId: currentTurnId, message });
    },

    interruptTurn: async () => {
      if (!currentTurnId) throw new Error('No active turn to interrupt');
      await rpc.request('turn/interrupt', { threadId, turnId: currentTurnId });
    },

    close: () => {
      alive = false;
      rpc.close();
    },
  };
};
