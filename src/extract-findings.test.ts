import { describe, it, expect } from 'vitest';
import { extractFindings } from './extract-findings.js';

describe('extractFindings', () => {
  it('returns assistant text verbatim from agent result', () => {
    const result = {
      exitCode: 0,
      assistantText: '## Review\n\nFound 3 issues:\n1. Bug in parser\n2. Missing test\n3. Type error',
      resultText: 'done',
      needsInput: false,
      sessionId: 'sess-1',
    };

    expect(extractFindings(result)).toBe(result.assistantText);
  });

  it('returns empty string when assistant text is empty', () => {
    const result = {
      exitCode: 0,
      assistantText: '',
      resultText: 'done',
      needsInput: false,
      sessionId: 'sess-1',
    };

    expect(extractFindings(result)).toBe('');
  });
});
