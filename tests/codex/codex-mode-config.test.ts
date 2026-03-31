import { describe, it, expect } from 'vitest';
import { resolveCodexModeConfig } from '../../src/infrastructure/codex/codex-mode-config.js';

describe('resolveCodexModeConfig', () => {
  it.each([
    { role: 'plan' as const, auto: false, noInteraction: false, sandbox: 'read-only', approvalMode: 'interactive' },
    { role: 'gap' as const, auto: false, noInteraction: false, sandbox: 'read-only', approvalMode: 'interactive' },
    { role: 'completeness' as const, auto: false, noInteraction: false, sandbox: 'read-only', approvalMode: 'interactive' },
    { role: 'tdd' as const, auto: false, noInteraction: false, sandbox: 'workspace-write', approvalMode: 'interactive' },
    { role: 'review' as const, auto: false, noInteraction: false, sandbox: 'workspace-write', approvalMode: 'interactive' },
    { role: 'verify' as const, auto: false, noInteraction: false, sandbox: 'workspace-write', approvalMode: 'interactive' },
    { role: 'final' as const, auto: false, noInteraction: false, sandbox: 'workspace-write', approvalMode: 'interactive' },
    { role: 'tdd' as const, auto: true, noInteraction: false, sandbox: 'workspace-write', approvalMode: 'auto-approve' },
    { role: 'tdd' as const, auto: false, noInteraction: true, sandbox: 'workspace-write', approvalMode: 'auto-approve' },
    { role: 'tdd' as const, auto: false, noInteraction: false, sandbox: 'workspace-write', approvalMode: 'interactive' },
    { role: 'tdd' as const, auto: true, noInteraction: true, sandbox: 'workspace-write', approvalMode: 'auto-approve' },
  ])('$role (auto=$auto, noInteraction=$noInteraction) → sandbox=$sandbox, approvalMode=$approvalMode', ({ role, auto, noInteraction, sandbox, approvalMode }) => {
    const result = resolveCodexModeConfig(role, { auto, noInteraction });
    expect(result).toEqual({ sandbox, approvalMode });
  });
});
