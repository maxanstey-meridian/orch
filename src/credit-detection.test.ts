import { describe, it, expect } from 'vitest';
import { detectCreditExhaustion } from './credit-detection.js';
import type { AgentResult } from './agent.js';

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: '',
  resultText: '',
  needsInput: false,
  sessionId: 'test',
  ...overrides,
});

describe('detectCreditExhaustion', () => {
  it('returns null when no pattern matches', () => {
    const result = makeResult({ resultText: 'All good, task complete.' });
    expect(detectCreditExhaustion(result, '')).toBeNull();
  });

  it('detects "rate limit" in resultText', () => {
    const result = makeResult({ resultText: 'Error: rate limit exceeded', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).toEqual({ kind: 'rejected', message: 'Rate limited. Wait and retry.' });
  });

  it('detects "rate limit" in stderr', () => {
    const result = makeResult({ exitCode: 1 });
    const signal = detectCreditExhaustion(result, 'rate limit hit');
    expect(signal).toEqual({ kind: 'rejected', message: 'Rate limited. Wait and retry.' });
  });

  it('detects "credit exhausted"', () => {
    const result = makeResult({ resultText: 'credit exhausted for this account', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).toEqual({ kind: 'rejected', message: 'Credits exhausted.' });
  });

  it('detects "credit limit"', () => {
    const result = makeResult({ resultText: 'You have hit your credit limit.', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).toEqual({ kind: 'rejected', message: 'Credits exhausted.' });
  });

  it('detects "credit exceeded"', () => {
    const result = makeResult({ resultText: 'credit exceeded', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).toEqual({ kind: 'rejected', message: 'Credits exhausted.' });
  });

  it('detects "quota exceeded"', () => {
    const result = makeResult({ resultText: 'API quota exceeded', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).toEqual({ kind: 'rejected', message: 'Quota exceeded.' });
  });

  it('detects "quota limit"', () => {
    const result = makeResult({ resultText: 'quota limit reached', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).toEqual({ kind: 'rejected', message: 'Quota exceeded.' });
  });

  it('detects "usage limit"', () => {
    const result = makeResult({ resultText: 'usage limit reached', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).toEqual({ kind: 'rejected', message: 'Usage limit reached.' });
  });

  it('is case-insensitive', () => {
    const result = makeResult({ resultText: 'RATE LIMIT exceeded', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal).not.toBeNull();
    expect(signal!.message).toBe('Rate limited. Wait and retry.');
  });

  it('returns "rejected" when assistantText is empty', () => {
    const result = makeResult({ resultText: 'rate limit', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    expect(signal!.kind).toBe('rejected');
  });

  it('returns "mid-response" when assistantText is non-empty and exit code is non-zero', () => {
    const result = makeResult({
      assistantText: 'I was working on...',
      resultText: 'rate limit',
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, '');
    expect(signal!.kind).toBe('mid-response');
  });

  it('returns null when exit code is zero even if pattern matches', () => {
    // Exit 0 means the agent completed normally — pattern match is incidental, not a credit issue
    const result = makeResult({
      assistantText: 'Some output',
      resultText: 'rate limit warning',
      exitCode: 0,
    });
    expect(detectCreditExhaustion(result, '')).toBeNull();
  });

  it('picks the first matching pattern when multiple match', () => {
    const result = makeResult({ resultText: 'rate limit and credit exhausted and quota exceeded', exitCode: 1 });
    const signal = detectCreditExhaustion(result, '');
    // "rate limit" is the first pattern
    expect(signal!.message).toBe('Rate limited. Wait and retry.');
  });
});
