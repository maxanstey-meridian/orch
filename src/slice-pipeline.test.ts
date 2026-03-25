import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSlices, type SlicePipelineDeps, type SlicePipelineOptions } from './slice-pipeline.js';
import type { AgentResult, AgentProcess } from './agent.js';
import type { Slice } from './plan-parser.js';
import type { OrchestratorState } from './state.js';

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: 'implemented stuff',
  resultText: 'done',
  needsInput: false,
  sessionId: 'sess-impl',
  ...overrides,
});

const makeAgent = (sendResults: AgentResult[] = [], quietResults: string[] = []): AgentProcess => {
  let sendIndex = 0;
  let quietIndex = 0;
  return {
    send: vi.fn().mockImplementation(() => {
      const r = sendResults[sendIndex] ?? makeResult();
      sendIndex++;
      return Promise.resolve(r);
    }),
    sendQuiet: vi.fn().mockImplementation(() => {
      const r = quietResults[quietIndex] ?? '## Summary\nDone.';
      quietIndex++;
      return Promise.resolve(r);
    }),
    kill: vi.fn(),
    alive: true,
    sessionId: 'sess-impl',
  };
};

const makeSlice = (n: number, title = `Slice ${n}`): Slice => ({
  number: n,
  title,
  content: `### ${title}\n\nContent for slice ${n}.`,
});

const makeDeps = (overrides: Partial<SlicePipelineDeps> = {}): SlicePipelineDeps => ({
  implAgent: makeAgent(),
  reviewAgent: makeAgent([makeResult({ assistantText: 'No issues found', sessionId: 'sess-review' })]),
  captureRef: vi.fn().mockResolvedValue('abc123'),
  hasChanges: vi.fn().mockResolvedValue(true),
  runTestGate: vi.fn().mockResolvedValue({ passed: true, output: '' }),
  handleFollowUps: vi.fn().mockImplementation(async (opts) => opts.result),
  extractFindings: vi.fn().mockReturnValue('No issues found'),
  extractFormattedFindings: vi.fn().mockResolvedValue('## Summary\nDone.'),
  isCleanReview: vi.fn().mockReturnValue(true),
  saveState: vi.fn().mockResolvedValue(undefined),
  log: vi.fn(),
  ...overrides,
});

const makeOpts = (overrides: Partial<SlicePipelineOptions> = {}): SlicePipelineOptions => ({
  slices: [makeSlice(1), makeSlice(2)],
  state: {},
  statePath: '/tmp/state.json',
  profile: { testCommand: 'npm test' },
  brief: '',
  cwd: '/tmp/repo',
  interactive: true,
  maxReviewCycles: 3,
  ...overrides,
});

describe('processSlices', () => {
  it('processes each slice in order', async () => {
    const deps = makeDeps();
    await processSlices(makeOpts(), deps);

    expect(deps.implAgent.send).toHaveBeenCalledTimes(2);
    expect(deps.saveState).toHaveBeenCalledTimes(2);
  });

  it('skips slices already completed in prior run', async () => {
    const deps = makeDeps();
    const opts = makeOpts({ state: { lastCompletedSlice: 1 } });
    await processSlices(opts, deps);

    // Only slice 2 should be processed
    expect(deps.implAgent.send).toHaveBeenCalledTimes(1);
    expect(deps.saveState).toHaveBeenCalledTimes(1);
  });

  it('runs test gate after implementation and skips slice on failure', async () => {
    const deps = makeDeps({
      runTestGate: vi.fn().mockResolvedValue({ passed: false, output: 'FAIL' }),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    expect(deps.runTestGate).toHaveBeenCalled();
    // Review cycle should not run when tests fail
    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    // Slice is NOT marked complete on test failure
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it('runs follow-up handler after implementation', async () => {
    const deps = makeDeps();
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    expect(deps.handleFollowUps).toHaveBeenCalled();
  });

  it('enters review cycle and exits clean when no findings', async () => {
    const deps = makeDeps({
      extractFindings: vi.fn().mockReturnValue('No issues found'),
      isCleanReview: vi.fn().mockReturnValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    expect(deps.reviewAgent.send).toHaveBeenCalledTimes(1);
    // No fix pass since review is clean
    expect(deps.implAgent.send).toHaveBeenCalledTimes(1); // only initial TDD
    expect(deps.saveState).toHaveBeenCalledTimes(1);
  });

  it('sends review findings to impl agent for fix pass', async () => {
    const reviewResult = makeResult({ assistantText: 'Found bug in X', sessionId: 'sess-review' });
    const fixResult = makeResult({ assistantText: 'Fixed it' });
    const reviewAgent = makeAgent([reviewResult, makeResult({ assistantText: 'No issues', sessionId: 'sess-review' })]);
    const implAgent = makeAgent([makeResult(), fixResult]);

    const deps = makeDeps({
      implAgent,
      reviewAgent,
      extractFindings: vi.fn()
        .mockReturnValueOnce('Found bug in X')
        .mockReturnValueOnce('No issues'),
      isCleanReview: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    // impl: TDD + fix = 2 sends
    expect(implAgent.send).toHaveBeenCalledTimes(2);
    // review: first review (findings) + second review (clean) = 2 sends
    expect(reviewAgent.send).toHaveBeenCalledTimes(2);
  });

  it('bounds review-fix cycles at maxReviewCycles', async () => {
    const reviewResult = makeResult({ assistantText: 'Still has issues', sessionId: 'sess-review' });
    const reviewAgent = makeAgent(Array(5).fill(reviewResult));
    const implAgent = makeAgent(Array(6).fill(makeResult()));

    const deps = makeDeps({
      implAgent,
      reviewAgent,
      extractFindings: vi.fn().mockReturnValue('Still has issues'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)], maxReviewCycles: 2 });
    await processSlices(opts, deps);

    // review runs exactly maxReviewCycles times
    expect(reviewAgent.send).toHaveBeenCalledTimes(2);
    // impl: TDD + 2 fix passes = 3
    expect(implAgent.send).toHaveBeenCalledTimes(3);
  });

  it('skips review when no changes since last baseline', async () => {
    const deps = makeDeps({
      hasChanges: vi.fn().mockResolvedValue(false),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    expect(deps.saveState).toHaveBeenCalledTimes(1);
  });

  it('marks slice complete in persistent state', async () => {
    const deps = makeDeps();
    const opts = makeOpts({ slices: [makeSlice(3)] });
    await processSlices(opts, deps);

    expect(deps.saveState).toHaveBeenCalledWith(
      '/tmp/state.json',
      expect.objectContaining({ lastCompletedSlice: 3 }),
    );
  });

  it('skips slice on implementation agent failure', async () => {
    const implAgent = makeAgent([makeResult({ exitCode: 1, assistantText: '' })]);
    const deps = makeDeps({ implAgent });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    expect(deps.runTestGate).not.toHaveBeenCalled();
    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it('distinguishes deliberate rejection from execution failure in fix pass', async () => {
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult]);

    // Fix pass: exitCode 0 but no changes = deliberate rejection
    const implAgent = makeAgent([makeResult(), makeResult({ exitCode: 0 })]);

    const deps = makeDeps({
      implAgent,
      reviewAgent,
      extractFindings: vi.fn().mockReturnValue('Found issue'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn()
        .mockResolvedValueOnce(true)     // has changes for review entry
        .mockResolvedValueOnce(false),   // no changes after fix = deliberate rejection
    });
    const opts = makeOpts({ slices: [makeSlice(1)], maxReviewCycles: 3 });
    await processSlices(opts, deps);

    // Review cycle ends after deliberate rejection — no second review
    expect(reviewAgent.send).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('deliberate'));
  });

  it('logs execution failure when fix pass has non-zero exit code', async () => {
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult, reviewResult]);

    // Fix pass fails with non-zero exit code
    const implAgent = makeAgent([makeResult(), makeResult({ exitCode: 1 })]);

    const deps = makeDeps({
      implAgent,
      reviewAgent,
      extractFindings: vi.fn().mockReturnValue('Found issue'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)], maxReviewCycles: 2 });
    await processSlices(opts, deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('failure'));
  });

  it('skips review extraction when review agent fails', async () => {
    const reviewAgent = makeAgent([makeResult({ exitCode: 1, assistantText: 'error', sessionId: 'sess-review' })]);

    const deps = makeDeps({
      reviewAgent,
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    // Should not attempt to extract findings from failed review
    expect(deps.extractFindings).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('review'));
  });

  it('extracts summary via quiet mode after processing', async () => {
    const deps = makeDeps();
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    expect(deps.extractFormattedFindings).toHaveBeenCalled();
  });

  it('continues test gate warning on failure during review cycle', async () => {
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const cleanReviewResult = makeResult({ assistantText: 'No issues', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult, cleanReviewResult]);
    const implAgent = makeAgent([makeResult(), makeResult()]);

    let testCallCount = 0;
    const deps = makeDeps({
      implAgent,
      reviewAgent,
      extractFindings: vi.fn()
        .mockReturnValueOnce('Found issue')
        .mockReturnValueOnce('No issues'),
      isCleanReview: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      hasChanges: vi.fn().mockResolvedValue(true),
      runTestGate: vi.fn().mockImplementation(() => {
        testCallCount++;
        // First call (post-TDD) passes, second call (post-fix) fails
        if (testCallCount === 1) return Promise.resolve({ passed: true, output: '' });
        return Promise.resolve({ passed: false, output: 'test fail' });
      }),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    // Review cycle should continue despite test failure in review fix
    expect(reviewAgent.send).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('test'));
  });

  it('advances review baseline after successful fix', async () => {
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const cleanReviewResult = makeResult({ assistantText: 'No issues', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult, cleanReviewResult]);
    const implAgent = makeAgent([makeResult(), makeResult()]);

    const captureRefMock = vi.fn()
      .mockResolvedValueOnce('ref-initial')
      .mockResolvedValueOnce('ref-after-fix');

    const deps = makeDeps({
      implAgent,
      reviewAgent,
      captureRef: captureRefMock,
      extractFindings: vi.fn()
        .mockReturnValueOnce('Found issue')
        .mockReturnValueOnce('No issues'),
      isCleanReview: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    // captureRef called for initial baseline and after fix
    expect(captureRefMock).toHaveBeenCalledTimes(2);
    // Second review checks changes against the advanced baseline
    expect(deps.hasChanges).toHaveBeenLastCalledWith('/tmp/repo', 'ref-after-fix');
  });

  it('continues to next slice after implementation failure on first slice', async () => {
    const implAgent = makeAgent([
      makeResult({ exitCode: 1, assistantText: '' }), // slice 1 fails
      makeResult(), // slice 2 succeeds
    ]);
    const deps = makeDeps({ implAgent });
    const opts = makeOpts({ slices: [makeSlice(1), makeSlice(2)] });
    await processSlices(opts, deps);

    expect(implAgent.send).toHaveBeenCalledTimes(2);
    expect(deps.saveState).toHaveBeenCalledTimes(1);
    expect(deps.saveState).toHaveBeenCalledWith(
      '/tmp/state.json',
      expect.objectContaining({ lastCompletedSlice: 2 }),
    );
  });

  it('marks slice complete even when review agent fails', async () => {
    const reviewAgent = makeAgent([makeResult({ exitCode: 1, sessionId: 'sess-review' })]);
    const deps = makeDeps({
      reviewAgent,
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)] });
    await processSlices(opts, deps);

    expect(deps.saveState).toHaveBeenCalledTimes(1);
    expect(deps.saveState).toHaveBeenCalledWith(
      '/tmp/state.json',
      expect.objectContaining({ lastCompletedSlice: 1 }),
    );
  });

  it('continues review cycle after execution failure in fix pass', async () => {
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const cleanResult = makeResult({ assistantText: 'No issues', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult, cleanResult]);

    // Fix pass 1 fails (exitCode 1), cycle continues to second review which is clean
    const implAgent = makeAgent([makeResult(), makeResult({ exitCode: 1 })]);

    const deps = makeDeps({
      implAgent,
      reviewAgent,
      extractFindings: vi.fn()
        .mockReturnValueOnce('Found issue')
        .mockReturnValueOnce('No issues'),
      isCleanReview: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      hasChanges: vi.fn().mockResolvedValue(true),
      captureRef: vi.fn()
        .mockResolvedValueOnce('ref-initial')
        .mockResolvedValueOnce('ref-initial'), // NOT advanced — fix failed
    });
    const opts = makeOpts({ slices: [makeSlice(1)], maxReviewCycles: 2 });
    await processSlices(opts, deps);

    // Review ran twice — cycle continued after execution failure
    expect(reviewAgent.send).toHaveBeenCalledTimes(2);
    // Baseline was NOT advanced (captureRef not called again for advancement)
    expect(deps.captureRef).toHaveBeenCalledTimes(1); // only initial baseline
  });

  it('updates state progressively across multiple slices', async () => {
    const deps = makeDeps();
    const opts = makeOpts({ slices: [makeSlice(1), makeSlice(2)] });
    await processSlices(opts, deps);

    expect(deps.saveState).toHaveBeenCalledTimes(2);
    expect(deps.saveState).toHaveBeenNthCalledWith(1,
      '/tmp/state.json',
      expect.objectContaining({ lastCompletedSlice: 1 }),
    );
    expect(deps.saveState).toHaveBeenNthCalledWith(2,
      '/tmp/state.json',
      expect.objectContaining({ lastCompletedSlice: 2 }),
    );
  });

  it('handles empty slices array with no side effects', async () => {
    const deps = makeDeps();
    const opts = makeOpts({ slices: [] });
    await processSlices(opts, deps);

    expect(deps.implAgent.send).not.toHaveBeenCalled();
    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it('skips review loop entirely when maxReviewCycles is 0', async () => {
    const deps = makeDeps({
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    const opts = makeOpts({ slices: [makeSlice(1)], maxReviewCycles: 0 });
    await processSlices(opts, deps);

    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    expect(deps.saveState).toHaveBeenCalledTimes(1);
    expect(deps.saveState).toHaveBeenCalledWith(
      '/tmp/state.json',
      expect.objectContaining({ lastCompletedSlice: 1 }),
    );
  });
});
