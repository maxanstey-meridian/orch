import type { JsonRpcNotification } from './codex-json-rpc.js';

export type CodexTurnError = {
  readonly code: string;
  readonly message: string;
};

export type CodexApprovalRequest = {
  readonly id: string;
  readonly kind: 'command' | 'fileChange' | 'permission';
  readonly summary: string;
};

export type CodexEvent =
  | { readonly kind: 'textDelta'; readonly text: string }
  | { readonly kind: 'toolActivity'; readonly summary: string }
  | { readonly kind: 'turnCompleted'; readonly resultText: string }
  | { readonly kind: 'turnFailed'; readonly error: CodexTurnError }
  | { readonly kind: 'approvalRequested'; readonly request: CodexApprovalRequest }
  | { readonly kind: 'ignored' };

export const normalizeNotification = (n: JsonRpcNotification): CodexEvent => {
  const params = n.params;

  switch (n.method) {
    case 'item/agentMessage/delta': {
      const text = params?.text;
      if (typeof text === 'string') return { kind: 'textDelta', text };
      return { kind: 'ignored' };
    }
    case 'codex/approvalRequest': {
      const validKinds = new Set(['command', 'fileChange', 'permission']);
      const kind = params?.kind;
      if (typeof kind !== 'string' || !validKinds.has(kind)) return { kind: 'ignored' };
      return {
        kind: 'approvalRequested',
        request: {
          id: String(params?.id ?? ''),
          kind: kind as CodexApprovalRequest['kind'],
          summary: String(params?.summary ?? ''),
        },
      };
    }
    case 'error': {
      return {
        kind: 'turnFailed',
        error: {
          code: String(params?.code ?? 'unknown'),
          message: String(params?.message ?? 'unknown'),
        },
      };
    }
    case 'turn/completed': {
      const result = params?.result ?? params?.text ?? '';
      return { kind: 'turnCompleted', resultText: String(result) };
    }
    case 'item/completed': {
      const cmd = params?.commandExecution;
      if (typeof cmd === 'object' && cmd !== null) {
        return { kind: 'toolActivity', summary: `command: ${String((cmd as Record<string, unknown>).command ?? 'unknown')}` };
      }
      const fc = params?.fileChange;
      if (typeof fc === 'object' && fc !== null) {
        return { kind: 'toolActivity', summary: `file change: ${String((fc as Record<string, unknown>).path ?? 'unknown')}` };
      }
      const mcp = params?.mcpToolCall;
      if (typeof mcp === 'object' && mcp !== null) {
        return { kind: 'toolActivity', summary: `mcp tool: ${String((mcp as Record<string, unknown>).name ?? 'unknown')}` };
      }
      return { kind: 'ignored' };
    }
    default:
      return { kind: 'ignored' };
  }
};
