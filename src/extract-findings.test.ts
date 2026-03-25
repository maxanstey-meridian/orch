import { describe, it, expect } from 'vitest';
import { extractFindings } from './extract-findings.js';
import type { AgentResult } from './agent.js';

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: '',
  resultText: 'done',
  needsInput: false,
  sessionId: 'sess-1',
  ...overrides,
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
