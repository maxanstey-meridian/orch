import { describe, it, expect } from 'vitest';
import { categorizeCodexError } from '../../src/infrastructure/codex/codex-error-mapper.js';

describe('categorizeCodexError', () => {
  it('maps serverOverloaded to retryable', () => {
    expect(categorizeCodexError({ code: 'serverOverloaded', message: 'server is overloaded' })).toBe('retryable');
  });

  it('maps rateLimited to retryable', () => {
    expect(categorizeCodexError({ code: 'rateLimited', message: 'too many requests' })).toBe('retryable');
  });

  it('maps usageLimitExceeded to creditExhausted', () => {
    expect(categorizeCodexError({ code: 'usageLimitExceeded', message: 'usage limit exceeded' })).toBe('creditExhausted');
  });

  it('maps unauthorized to unauthorized', () => {
    expect(categorizeCodexError({ code: 'unauthorized', message: 'invalid api key' })).toBe('unauthorized');
  });

  it('maps connectionFailed to retryable', () => {
    expect(categorizeCodexError({ code: 'connectionFailed', message: 'connection failed' })).toBe('retryable');
  });

  it('maps timeout to retryable', () => {
    expect(categorizeCodexError({ code: 'timeout', message: 'request timed out' })).toBe('retryable');
  });

  it('maps unknown code to unknown', () => {
    expect(categorizeCodexError({ code: 'somethingWeird', message: 'wat' })).toBe('unknown');
  });

  it('maps empty code to unknown', () => {
    expect(categorizeCodexError({ code: '', message: '' })).toBe('unknown');
  });

  it('is pure — same input always yields same result', () => {
    const err = { code: 'rateLimited', message: 'slow down' } as const;
    expect(categorizeCodexError(err)).toBe(categorizeCodexError(err));
  });
});
