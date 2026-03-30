import { describe, it, expect } from 'vitest';
import { normalizeNotification } from '../../src/infrastructure/codex/codex-notifications.js';

describe('normalizeNotification', () => {
  it('returns ignored for unknown method', () => {
    expect(normalizeNotification({ method: 'some/unknown' })).toEqual({ kind: 'ignored' });
  });

  it('maps text delta with text', () => {
    expect(
      normalizeNotification({ method: 'item/agentMessage/delta', params: { text: 'hello' } }),
    ).toEqual({ kind: 'textDelta', text: 'hello' });
  });

  it('returns ignored for text delta with missing text field', () => {
    expect(
      normalizeNotification({ method: 'item/agentMessage/delta', params: {} }),
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

  it('maps turn/completed with result text', () => {
    expect(
      normalizeNotification({
        method: 'turn/completed',
        params: { result: 'Done. All tests pass.' },
      }),
    ).toEqual({ kind: 'turnCompleted', resultText: 'Done. All tests pass.' });
  });

  it('maps turn/completed with empty result to empty string', () => {
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
