import { describe, it, expect, vi } from 'vitest';
import {
  runOrchestrator,
  resolveStartGroup,
  type OrchestratorDeps,
  type OrchestratorArgs,
} from './orchestrator.js';
import type { Group } from './plan-parser.js';

const makeGroup = (name: string, sliceNumbers: number[] = [1]): Group => ({
  name,
  slices: sliceNumbers.map(n => ({ number: n, title: `Slice ${n}`, content: `Content ${n}` })),
});

const makeDeps = (overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  parsePlan: vi.fn().mockResolvedValue([makeGroup('Core'), makeGroup('Extensions', [2, 3])]),
  runFingerprint: vi.fn().mockResolvedValue({ brief: '# Brief', profile: { stack: 'typescript', testCommand: 'vitest run' } }),
  loadState: vi.fn().mockResolvedValue({}),
  clearState: vi.fn().mockResolvedValue(undefined),
  captureRef: vi.fn().mockResolvedValue('baseline-ref'),
  hasChanges: vi.fn().mockResolvedValue(true),
  processSlices: vi.fn().mockResolvedValue(undefined),
  runGapAnalysis: vi.fn().mockResolvedValue(undefined),
  runFinalReview: vi.fn().mockResolvedValue(undefined),
  promptContinue: vi.fn().mockResolvedValue(true),
  log: vi.fn(),
  ...overrides,
});

const makeArgs = (overrides: Partial<OrchestratorArgs> = {}): OrchestratorArgs => ({
  planPath: '/tmp/plan.md',
  automatic: false,
  skipFingerprint: false,
  noInteraction: false,
  ...overrides,
});

describe('resolveStartGroup', () => {
  const groups = [makeGroup('Core'), makeGroup('Extensions'), makeGroup('Polish')];

  it('returns index 0 when no filter is provided', () => {
    expect(resolveStartGroup(groups)).toBe(0);
  });

  it('returns matching group index (case-insensitive)', () => {
    expect(resolveStartGroup(groups, 'extensions')).toBe(1);
    expect(resolveStartGroup(groups, 'POLISH')).toBe(2);
  });

  it('returns -1 when filter does not match any group', () => {
    expect(resolveStartGroup(groups, 'nonexistent')).toBe(-1);
  });
});

describe('runOrchestrator', () => {
  it('parses plan and processes all groups', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs(), deps);

    expect(deps.parsePlan).toHaveBeenCalledWith('/tmp/plan.md');
    expect(deps.processSlices).toHaveBeenCalledTimes(2);
    expect(deps.runGapAnalysis).toHaveBeenCalledTimes(2);
  });

  it('terminates with error when plan has no groups', async () => {
    const deps = makeDeps({ parsePlan: vi.fn().mockResolvedValue([]) });
    await runOrchestrator(makeArgs(), deps);

    expect(deps.processSlices).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('No groups'));
  });

  it('generates fingerprint unless skipped', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs(), deps);
    expect(deps.runFingerprint).toHaveBeenCalled();

    const deps2 = makeDeps();
    await runOrchestrator(makeArgs({ skipFingerprint: true }), deps2);
    expect(deps2.runFingerprint).not.toHaveBeenCalled();
  });

  it('loads persisted state for resume', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs(), deps);
    expect(deps.loadState).toHaveBeenCalled();
  });

  it('captures run baseline before processing', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs(), deps);
    expect(deps.captureRef).toHaveBeenCalled();
  });

  it('filters to starting group when groupFilter is set', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ groupFilter: 'Extensions' }), deps);

    // Only the second group should be processed
    expect(deps.processSlices).toHaveBeenCalledTimes(1);
    expect(deps.runGapAnalysis).toHaveBeenCalledTimes(1);
  });

  it('terminates with error when groupFilter does not match', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ groupFilter: 'nonexistent' }), deps);

    expect(deps.processSlices).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Core'));
  });

  it('prompts between groups in interactive mode', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs(), deps);

    // Prompted once between Core and Extensions (not after the last group)
    expect(deps.promptContinue).toHaveBeenCalledTimes(1);
  });

  it('skips inter-group prompts in automatic mode', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ automatic: true }), deps);

    expect(deps.promptContinue).not.toHaveBeenCalled();
    expect(deps.processSlices).toHaveBeenCalledTimes(2);
  });

  it('skips inter-group prompts when noInteraction is set', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ noInteraction: true }), deps);

    expect(deps.promptContinue).not.toHaveBeenCalled();
  });

  it('terminates when operator declines to continue', async () => {
    const deps = makeDeps({ promptContinue: vi.fn().mockResolvedValue(false) });
    await runOrchestrator(makeArgs(), deps);

    // Only first group processed
    expect(deps.processSlices).toHaveBeenCalledTimes(1);
    expect(deps.runGapAnalysis).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('resume'));
  });

  it('signals compaction for groups after the first', async () => {
    const groups = [makeGroup('A'), makeGroup('B'), makeGroup('C')];
    const deps = makeDeps({
      parsePlan: vi.fn().mockResolvedValue(groups),
      promptContinue: vi.fn().mockResolvedValue(true),
    });
    await runOrchestrator(makeArgs({ automatic: true }), deps);

    // processSlices called 3 times — check compaction signal
    expect(deps.processSlices).toHaveBeenCalledTimes(3);
    // First group: no compaction; second and third: compaction
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('compaction'));
  });

  it('runs final review after all groups', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ automatic: true }), deps);

    expect(deps.runFinalReview).toHaveBeenCalledTimes(1);
  });

  it('skips final review when no changes during run', async () => {
    const deps = makeDeps({
      hasChanges: vi.fn().mockResolvedValue(false),
    });
    await runOrchestrator(makeArgs({ automatic: true }), deps);

    expect(deps.runFinalReview).not.toHaveBeenCalled();
  });

  it('clears state on successful completion', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ automatic: true }), deps);

    expect(deps.clearState).toHaveBeenCalled();
  });

  it('does not clear state when operator declined continuation', async () => {
    const deps = makeDeps({ promptContinue: vi.fn().mockResolvedValue(false) });
    await runOrchestrator(makeArgs(), deps);

    expect(deps.clearState).not.toHaveBeenCalled();
  });

  it('passes noInteraction as interactive=false to processSlices', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ noInteraction: true }), deps);

    // processSlices should receive interactive: false
    const call = (deps.processSlices as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toHaveProperty('interactive', false);
  });

  it('warns when fingerprint is skipped and no profile available', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ skipFingerprint: true }), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('fingerprint'));
  });

  it('runs gap analysis after each group', async () => {
    const deps = makeDeps();
    await runOrchestrator(makeArgs({ automatic: true }), deps);

    expect(deps.runGapAnalysis).toHaveBeenCalledTimes(2);
  });
});
