import { describe, it, expect, vi } from 'vitest';
import { extractFindings, extractFormattedFindings } from './extract-findings.js';
import type { AgentProcess, AgentResult } from './agent.js';

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: '',
  resultText: 'done',
  needsInput: false,
  sessionId: 'sess-1',
  ...overrides,
});

const makeAgent = (sendQuietResult: string | Error = ''): AgentProcess => ({
  send: vi.fn(),
  sendQuiet: typeof sendQuietResult === 'string'
    ? vi.fn().mockResolvedValue(sendQuietResult)
    : vi.fn().mockRejectedValue(sendQuietResult),
  kill: vi.fn(),
  alive: true,
  sessionId: 'sess-1',
});

describe('extractFindings', () => {
  it('returns assistant text verbatim from agent result', () => {
    const result = makeResult({
      assistantText: '## Review\n\nFound 3 issues:\n1. Bug in parser\n2. Missing test\n3. Type error',
    });

    expect(extractFindings(result)).toBe(result.assistantText);
  });

  it('returns empty string when assistant text is empty', () => {
    expect(extractFindings(makeResult())).toBe('');
  });

  it('does not modify or filter the agent output', () => {
    const text = '  leading whitespace\ntrailing whitespace  \n\n';
    expect(extractFindings(makeResult({ assistantText: text }))).toBe(text);
  });
});

describe('extractFormattedFindings', () => {
  it('sends the formatting prompt via sendQuiet and returns the result', async () => {
    const agent = makeAgent('## Summary\n1. Issue one');
    const result = await extractFormattedFindings(agent, 'Summarise your findings');
    expect(agent.sendQuiet).toHaveBeenCalledWith('Summarise your findings');
    expect(result).toBe('## Summary\n1. Issue one');
  });

  it('returns empty string when sendQuiet returns empty', async () => {
    const agent = makeAgent('');
    const result = await extractFormattedFindings(agent, 'Summarise');
    expect(result).toBe('');
  });

  it('returns empty string when sendQuiet rejects', async () => {
    const agent = makeAgent(new Error('process died'));
    const result = await extractFormattedFindings(agent, 'Summarise');
    expect(result).toBe('');
  });
});
