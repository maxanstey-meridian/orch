import { describe, it, expect } from 'vitest';
import { normalizeNotification } from '../../src/infrastructure/codex/codex-notifications.js';

describe('normalizeNotification', () => {
  it('returns ignored for unknown method', () => {
    expect(normalizeNotification({ method: 'some/unknown' })).toEqual({ kind: 'ignored' });
  });

  it('maps text delta from params.delta', () => {
    expect(
      normalizeNotification({ method: 'item/agentMessage/delta', params: { delta: 'hello' } }),
    ).toEqual({ kind: 'textDelta', text: 'hello' });
  });

  it('returns ignored for text delta with missing delta field', () => {
    expect(
      normalizeNotification({ method: 'item/agentMessage/delta', params: {} }),
    ).toEqual({ kind: 'ignored' });
  });

  it('returns ignored for text delta with wrong field name (text instead of delta)', () => {
    expect(
      normalizeNotification({ method: 'item/agentMessage/delta', params: { text: 'hello' } }),
    ).toEqual({ kind: 'ignored' });
  });

  it('maps command execution to tool activity', () => {
    expect(
      normalizeNotification({
        method: 'item/completed',
        params: { commandExecution: { command: 'npm test' } },
      }),
    ).toEqual({ kind: 'toolActivity', summary: 'command: npm test' });
  });

  it('maps file change to tool activity', () => {
    expect(
      normalizeNotification({
        method: 'item/completed',
        params: { fileChange: { path: 'src/foo.ts' } },
      }),
    ).toEqual({ kind: 'toolActivity', summary: 'file change: src/foo.ts' });
  });

  it('maps MCP tool call to tool activity', () => {
    expect(
      normalizeNotification({
        method: 'item/completed',
        params: { mcpToolCall: { name: 'read_file' } },
      }),
    ).toEqual({ kind: 'toolActivity', summary: 'mcp tool: read_file' });
  });

  it('maps turn/completed as signal (result text comes from accumulated deltas)', () => {
    expect(
      normalizeNotification({
        method: 'turn/completed',
        params: { turn: { status: 'completed' } },
      }),
    ).toEqual({ kind: 'turnCompleted', resultText: '' });
  });

  it('maps turn/completed with empty params', () => {
    expect(
      normalizeNotification({ method: 'turn/completed', params: {} }),
    ).toEqual({ kind: 'turnCompleted', resultText: '' });
  });

  it('maps error notification to turnFailed', () => {
    expect(
      normalizeNotification({
        method: 'error',
        params: { code: 'rateLimited', message: 'Too many requests' },
      }),
    ).toEqual({
      kind: 'turnFailed',
      error: { code: 'rateLimited', message: 'Too many requests' },
    });
  });

  it('returns ignored for item/completed with no recognized tool params', () => {
    expect(
      normalizeNotification({ method: 'item/completed', params: { someOther: true } }),
    ).toEqual({ kind: 'ignored' });
  });

  it('turn/completed ignores unexpected fields', () => {
    expect(
      normalizeNotification({ method: 'turn/completed', params: { text: 'ignored', turn: { status: 'completed' } } }),
    ).toEqual({ kind: 'turnCompleted', resultText: '' });
  });

  it('defaults code and message to unknown when error params are empty', () => {
    expect(
      normalizeNotification({ method: 'error', params: {} }),
    ).toEqual({ kind: 'turnFailed', error: { code: 'unknown', message: 'unknown' } });
  });

  it('returns ignored for approval request with invalid kind', () => {
    expect(
      normalizeNotification({
        method: 'codex/approvalRequest',
        params: { id: 'x', kind: 'invalidThing', summary: 's' },
      }),
    ).toEqual({ kind: 'ignored' });
  });

  it('defaults id and summary to empty strings when missing from approval request', () => {
    expect(
      normalizeNotification({
        method: 'codex/approvalRequest',
        params: { kind: 'command' },
      }),
    ).toEqual({
      kind: 'approvalRequested',
      request: { id: '', kind: 'command', summary: '' },
    });
  });

  it('maps item/commandExecution/requestApproval to approvalRequested', () => {
    expect(
      normalizeNotification({
        method: 'item/commandExecution/requestApproval',
        params: {
          itemId: 'call_abc123',
          reason: 'Do you want to allow Git index updates?',
          command: '/bin/zsh -lc \'git add file.txt\'',
        },
      }),
    ).toEqual({
      kind: 'approvalRequested',
      request: { id: 'call_abc123', kind: 'command', summary: 'Do you want to allow Git index updates?' },
    });
  });

  it('maps item/commandExecution/requestApproval falls back to command when reason missing', () => {
    expect(
      normalizeNotification({
        method: 'item/commandExecution/requestApproval',
        params: {
          itemId: 'call_xyz',
          command: 'git commit -m test',
        },
      }),
    ).toEqual({
      kind: 'approvalRequested',
      request: { id: 'call_xyz', kind: 'command', summary: 'git commit -m test' },
    });
  });

  it('maps item/started command execution to a shell-unwrapped tool activity summary', () => {
    expect(
      normalizeNotification({
        method: 'item/started',
        params: {
          item: {
            type: 'commandExecution',
            command: "/bin/zsh -lc 'git add tests/ui/ink-operator-gate.test.ts'",
          },
        },
      }),
    ).toEqual({
      kind: 'toolActivity',
      summary: 'Running: git add tests/ui/ink-operator-gate.test.ts',
    });
  });

  it('truncates the unwrapped item/started command summary to 80 characters', () => {
    const longCommand = 'x'.repeat(120);

    expect(
      normalizeNotification({
        method: 'item/started',
        params: {
          item: {
            type: 'commandExecution',
            command: `/bin/bash -lc "${longCommand}"`,
          },
        },
      }),
    ).toEqual({
      kind: 'toolActivity',
      summary: `Running: ${'x'.repeat(80)}`,
    });
  });

  it('maps approval request to approvalRequested', () => {
    expect(
      normalizeNotification({
        method: 'codex/approvalRequest',
        params: { id: 'req-1', kind: 'command', summary: 'run rm -rf /' },
      }),
    ).toEqual({
      kind: 'approvalRequested',
      request: { id: 'req-1', kind: 'command', summary: 'run rm -rf /' },
    });
  });
});
