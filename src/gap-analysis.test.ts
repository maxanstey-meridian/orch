import { describe, it, expect, vi } from 'vitest';
import { runGapAnalysis, type GapAnalysisDeps, type GapAnalysisOptions } from './gap-analysis.js';
import type { AgentResult, AgentProcess } from './agent.js';

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: 'gap findings here',
  resultText: 'done',
  needsInput: false,
  sessionId: 'sess-gap',
  ...overrides,
});

const makeAgent = (sendResults: AgentResult[] = []): AgentProcess => {
  let sendIndex = 0;
  return {
    send: vi.fn().mockImplementation(() => {
      const r = sendResults[sendIndex] ?? makeResult();
      sendIndex++;
      return Promise.resolve(r);
    }),
    sendQuiet: vi.fn().mockResolvedValue(''),
    kill: vi.fn(),
    alive: true,
    sessionId: 'sess-gap',
  };
};

const makeDeps = (overrides: Partial<GapAnalysisDeps> = {}): GapAnalysisDeps => ({
  gapAgent: makeAgent([makeResult({ assistantText: 'NO_GAPS_FOUND' })]),
  implAgent: makeAgent(),
  reviewAgent: makeAgent([makeResult({ assistantText: 'No issues found', sessionId: 'sess-review' })]),
  hasChanges: vi.fn().mockResolvedValue(true),
  captureRef: vi.fn().mockResolvedValue('ref-1'),
  runTestGate: vi.fn().mockResolvedValue({ passed: true, output: '' }),
  extractFindings: vi.fn().mockReturnValue(''),
  isCleanReview: vi.fn().mockReturnValue(true),
  log: vi.fn(),
  ...overrides,
});

const makeOpts = (overrides: Partial<GapAnalysisOptions> = {}): GapAnalysisOptions => ({
  slices: [
    { number: 1, title: 'Slice 1', content: 'Content 1' },
    { number: 2, title: 'Slice 2', content: 'Content 2' },
  ],
  baseline: 'abc123',
  profile: { testCommand: 'npm test' },
  cwd: '/tmp/repo',
  maxReviewCycles: 3,
  ...overrides,
});

describe('runGapAnalysis', () => {
  it('skips entirely when no changes since group baseline', async () => {
    const deps = makeDeps({
      hasChanges: vi.fn().mockResolvedValue(false),
    });
    await runGapAnalysis(makeOpts(), deps);

    expect(deps.gapAgent.send).not.toHaveBeenCalled();
    expect(deps.implAgent.send).not.toHaveBeenCalled();
  });

  it('aggregates all slice content and sends to gap agent', async () => {
    const deps = makeDeps();
    await runGapAnalysis(makeOpts(), deps);

    const prompt = (deps.gapAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('Content 1');
    expect(prompt).toContain('Content 2');
  });

  it('takes no action when gap agent returns NO_GAPS_FOUND sentinel', async () => {
    const deps = makeDeps({
      gapAgent: makeAgent([makeResult({ assistantText: 'NO_GAPS_FOUND' })]),
    });
    await runGapAnalysis(makeOpts(), deps);

    expect(deps.gapAgent.send).toHaveBeenCalledTimes(1);
    expect(deps.implAgent.send).not.toHaveBeenCalled();
  });

  it('takes no action when gap agent returns empty text', async () => {
    const deps = makeDeps({
      gapAgent: makeAgent([makeResult({ assistantText: '' })]),
    });
    await runGapAnalysis(makeOpts(), deps);

    expect(deps.implAgent.send).not.toHaveBeenCalled();
  });

  it('sends gap findings to impl agent when gaps are found', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test for edge case X' })]);
    const implAgent = makeAgent([makeResult()]);
    const deps = makeDeps({ gapAgent, implAgent });
    await runGapAnalysis(makeOpts(), deps);

    expect(implAgent.send).toHaveBeenCalledTimes(1);
    const prompt = (implAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('Missing test for edge case X');
  });

  it('runs test gate after gap implementation', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test' })]);
    const deps = makeDeps({ gapAgent });
    await runGapAnalysis(makeOpts(), deps);

    expect(deps.runTestGate).toHaveBeenCalled();
  });

  it('skips review cycle when test gate fails after gap implementation', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test' })]);
    const deps = makeDeps({
      gapAgent,
      runTestGate: vi.fn().mockResolvedValue({ passed: false, output: 'FAIL' }),
    });
    await runGapAnalysis(makeOpts(), deps);

    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('test'));
  });

  it('runs review-fix cycle after gap tests pass', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test' })]);
    const reviewAgent = makeAgent([makeResult({ assistantText: 'No issues', sessionId: 'sess-review' })]);
    const deps = makeDeps({
      gapAgent,
      reviewAgent,
      extractFindings: vi.fn().mockReturnValue('No issues'),
      isCleanReview: vi.fn().mockReturnValue(true),
    });
    await runGapAnalysis(makeOpts(), deps);

    expect(reviewAgent.send).toHaveBeenCalledTimes(1);
  });

  it('bounds review-fix cycle at maxReviewCycles', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test' })]);
    const reviewResult = makeResult({ assistantText: 'Still issues', sessionId: 'sess-review' });
    const reviewAgent = makeAgent(Array(5).fill(reviewResult));
    const implAgent = makeAgent(Array(5).fill(makeResult()));

    const deps = makeDeps({
      gapAgent,
      reviewAgent,
      implAgent,
      extractFindings: vi.fn().mockReturnValue('Still issues'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    await runGapAnalysis(makeOpts({ maxReviewCycles: 2 }), deps);

    // impl: gap fix + 2 review fixes = 3
    expect(implAgent.send).toHaveBeenCalledTimes(3);
    expect(reviewAgent.send).toHaveBeenCalledTimes(2);
  });

  it('logs and skips when gap agent fails with non-zero exit', async () => {
    const gapAgent = makeAgent([makeResult({ exitCode: 1, assistantText: 'error' })]);
    const deps = makeDeps({ gapAgent });
    await runGapAnalysis(makeOpts(), deps);

    expect(deps.implAgent.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('gap agent failure'));
  });

  it('logs deliberate rejection when impl makes no changes with exit 0', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test' })]);
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult]);
    const implAgent = makeAgent([makeResult(), makeResult({ exitCode: 0 })]);

    const deps = makeDeps({
      gapAgent,
      reviewAgent,
      implAgent,
      extractFindings: vi.fn().mockReturnValue('Found issue'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn()
        .mockResolvedValueOnce(true)   // group baseline check
        .mockResolvedValueOnce(true)   // review entry check
        .mockResolvedValueOnce(false), // no changes after fix = deliberate rejection
    });
    await runGapAnalysis(makeOpts(), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('deliberate'));
    expect(reviewAgent.send).toHaveBeenCalledTimes(1);
  });

  it('logs execution failure when impl fix has non-zero exit', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test' })]);
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult, reviewResult]);
    const implAgent = makeAgent([makeResult(), makeResult({ exitCode: 1 })]);

    const deps = makeDeps({
      gapAgent,
      reviewAgent,
      implAgent,
      extractFindings: vi.fn().mockReturnValue('Found issue'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    await runGapAnalysis(makeOpts({ maxReviewCycles: 2 }), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('failure'));
  });

  it('advances review baseline after successful fix', async () => {
    const gapAgent = makeAgent([makeResult({ assistantText: 'Missing test' })]);
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const cleanResult = makeResult({ assistantText: 'No issues', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult, cleanResult]);
    const implAgent = makeAgent([makeResult(), makeResult()]);

    const captureRefMock = vi.fn()
      .mockResolvedValueOnce('ref-1')
      .mockResolvedValueOnce('ref-2');

    const deps = makeDeps({
      gapAgent,
      reviewAgent,
      implAgent,
      captureRef: captureRefMock,
      extractFindings: vi.fn()
        .mockReturnValueOnce('Found issue')
        .mockReturnValueOnce('No issues'),
      isCleanReview: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    await runGapAnalysis(makeOpts(), deps);

    expect(captureRefMock).toHaveBeenCalledTimes(2);
    expect(deps.hasChanges).toHaveBeenLastCalledWith('/tmp/repo', 'ref-2');
  });
});
