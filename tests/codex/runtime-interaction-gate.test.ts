import { describe, it, expect, vi } from 'vitest';
import {
  RuntimeInteractionGate,
  type RuntimeInteractionRequest,
} from '../../src/application/ports/runtime-interaction.port.js';
import {
  SilentRuntimeInteractionGate,
  InkRuntimeInteractionGate,
} from '../../src/ui/ink-runtime-interaction-gate.js';
import { runtimeInteractionGateFactory } from '../../src/infrastructure/factories.js';
import { AGENT_DEFAULTS } from '../../src/domain/agent-config.js';
import type { OrchestratorConfig } from '../../src/domain/config.js';
import type { Hud } from '../../src/ui/hud.js';

const mockHud = (answer: string): Hud =>
  ({ askUser: vi.fn().mockResolvedValue(answer) }) as unknown as Hud;

describe('RuntimeInteractionGate port', () => {
  it('defines decide as an abstract method requiring implementation', () => {
    expect(RuntimeInteractionGate.prototype.decide).toBeUndefined();
  });
});

describe('SilentRuntimeInteractionGate', () => {
  const gate = new SilentRuntimeInteractionGate();

  it('returns approve for commandApproval', async () => {
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'approve' });
  });

  it('returns approve for fileChangeApproval', async () => {
    const result = await gate.decide({
      kind: 'fileChangeApproval',
      summary: 'modify src/foo.ts',
      files: ['src/foo.ts'],
    });
    expect(result).toEqual({ kind: 'approve' });
  });

  it('returns approve for permissionApproval', async () => {
    const result = await gate.decide({ kind: 'permissionApproval', summary: 'access network' });
    expect(result).toEqual({ kind: 'approve' });
  });
});

describe('InkRuntimeInteractionGate', () => {
  it('calls hud.askUser and maps y to approve', async () => {
    const hud = mockHud('y');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'approve' });
    expect(hud.askUser).toHaveBeenCalledOnce();
  });

  it('maps n to reject', async () => {
    const hud = mockHud('n');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'reject' });
  });

  it('maps no to reject', async () => {
    const hud = mockHud('no');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'reject' });
  });

  it('maps c to cancel', async () => {
    const hud = mockHud('c');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'cancel' });
  });

  it('maps cancel to cancel', async () => {
    const hud = mockHud('cancel');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'cancel' });
  });

  it('maps yes to approve', async () => {
    const hud = mockHud('yes');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'approve' });
  });

  it('defaults empty input to approve', async () => {
    const hud = mockHud('');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'approve' });
  });

  it('defaults unrecognized input to approve', async () => {
    const hud = mockHud('maybe');
    const gate = new InkRuntimeInteractionGate(hud);
    const result = await gate.decide({ kind: 'commandApproval', summary: 'run npm test' });
    expect(result).toEqual({ kind: 'approve' });
  });
});

describe('runtimeInteractionGateFactory', () => {
  const baseConfig = {
    auto: false,
    cwd: '/tmp',
    planPath: '',
    planContent: '',
    brief: '',
    reviewThreshold: 0,
    maxReviewCycles: 0,
    stateFile: '',
    logPath: null,
    tddSkill: null,
    reviewSkill: null,
    verifySkill: null,
    gapDisabled: false,
    planDisabled: false,
    maxReplans: 0,
    defaultProvider: 'claude' as const,
    agentConfig: AGENT_DEFAULTS,
  } satisfies OrchestratorConfig;

  it('returns SilentRuntimeInteractionGate when auto is true', () => {
    const gate = runtimeInteractionGateFactory({ ...baseConfig, auto: true }, mockHud(''));
    expect(gate).toBeInstanceOf(SilentRuntimeInteractionGate);
  });

  it('returns SilentRuntimeInteractionGate when auto is true', () => {
    const gate = runtimeInteractionGateFactory({ ...baseConfig, auto: true }, mockHud(''));
    expect(gate).toBeInstanceOf(SilentRuntimeInteractionGate);
  });

  it('returns InkRuntimeInteractionGate when both flags are false', () => {
    const gate = runtimeInteractionGateFactory(baseConfig, mockHud(''));
    expect(gate).toBeInstanceOf(InkRuntimeInteractionGate);
  });
});
