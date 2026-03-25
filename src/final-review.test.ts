import { describe, it, expect, vi } from 'vitest';
import { runFinalReview, type FinalReviewDeps, type FinalReviewOptions, AUDIT_PASSES } from './final-review.js';
import type { AgentResult, AgentProcess } from './agent.js';

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: 'NO_ISSUES_FOUND',
  resultText: 'done',
  needsInput: false,
  sessionId: 'sess-audit',
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
    sessionId: 'sess-audit',
  };
};

const makeDeps = (overrides: Partial<FinalReviewDeps> = {}): FinalReviewDeps => ({
  createAuditAgent: vi.fn().mockReturnValue(makeAgent()),
  implAgent: makeAgent(),
  reviewAgent: makeAgent([makeResult({ assistantText: 'No issues', sessionId: 'sess-review' })]),
  hasChanges: vi.fn().mockResolvedValue(true),
  captureRef: vi.fn().mockResolvedValue('ref-1'),
  runTestGate: vi.fn().mockResolvedValue({ passed: true, output: '' }),
  extractFindings: vi.fn().mockReturnValue(''),
  isCleanReview: vi.fn().mockReturnValue(true),
  log: vi.fn(),
  ...overrides,
});

const makeOpts = (overrides: Partial<FinalReviewOptions> = {}): FinalReviewOptions => ({
  runBaseline: 'run-baseline-abc',
  planContent: '# Full plan\n\nSlice 1...\nSlice 2...',
  profile: { stack: 'typescript', testCommand: 'vitest run' },
  cwd: '/tmp/repo',
  maxReviewCycles: 3,
  ...overrides,
});

describe('AUDIT_PASSES', () => {
  it('defines exactly three passes in fixed order', () => {
    expect(AUDIT_PASSES).toHaveLength(3);
    expect(AUDIT_PASSES[0].name).toBe('type-fidelity');
    expect(AUDIT_PASSES[1].name).toBe('plan-completeness');
    expect(AUDIT_PASSES[2].name).toBe('cross-component');
  });
});

describe('runFinalReview', () => {
  it('skips entirely when no changes since run baseline', async () => {
    const deps = makeDeps({
      hasChanges: vi.fn().mockResolvedValue(false),
    });
    await runFinalReview(makeOpts(), deps);

    expect(deps.createAuditAgent).not.toHaveBeenCalled();
    expect(deps.implAgent.send).not.toHaveBeenCalled();
  });

  it('creates three fresh audit agents — one per pass', async () => {
    const deps = makeDeps();
    await runFinalReview(makeOpts(), deps);

    expect(deps.createAuditAgent).toHaveBeenCalledTimes(3);
  });

  it('passes stack identity to each audit agent prompt', async () => {
    const auditAgent = makeAgent();
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
    });
    await runFinalReview(makeOpts(), deps);

    for (let i = 0; i < 3; i++) {
      const prompt = (auditAgent.send as ReturnType<typeof vi.fn>).mock.calls[i][0] as string;
      expect(prompt).toContain('typescript');
    }
  });

  it('takes no action for a pass when audit returns NO_ISSUES_FOUND', async () => {
    const deps = makeDeps();
    await runFinalReview(makeOpts(), deps);

    // All three audits clean — no fix calls
    expect(deps.implAgent.send).not.toHaveBeenCalled();
  });

  it('takes no action for a pass when audit returns empty text', async () => {
    const auditAgent = makeAgent([makeResult({ assistantText: '' })]);
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
    });
    await runFinalReview(makeOpts(), deps);

    expect(deps.implAgent.send).not.toHaveBeenCalled();
  });

  it('sends findings to impl agent when audit finds issues', async () => {
    const auditAgent = makeAgent([
      makeResult({ assistantText: 'Type issue in foo.ts:10' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
    ]);
    const implAgent = makeAgent([makeResult()]);
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
      implAgent,
    });
    await runFinalReview(makeOpts(), deps);

    expect(implAgent.send).toHaveBeenCalledTimes(1);
    const prompt = (implAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('Type issue in foo.ts:10');
  });

  it('runs test gate after fix and proceeds to next pass on failure', async () => {
    const auditAgent = makeAgent([
      makeResult({ assistantText: 'Type issue' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
    ]);
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
      runTestGate: vi.fn().mockResolvedValue({ passed: false, output: 'FAIL' }),
    });
    await runFinalReview(makeOpts(), deps);

    // Test gate failed after pass 1 fix — skips review, proceeds to pass 2 and 3
    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('test'));
    // All 3 audit agents still created
    expect(deps.createAuditAgent).toHaveBeenCalledTimes(3);
  });

  it('enters review-fix cycle after successful test gate', async () => {
    const auditAgent = makeAgent([
      makeResult({ assistantText: 'Found issue' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
    ]);
    const reviewAgent = makeAgent([makeResult({ assistantText: 'No issues', sessionId: 'sess-review' })]);
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
      reviewAgent,
      extractFindings: vi.fn().mockReturnValue('No issues'),
      isCleanReview: vi.fn().mockReturnValue(true),
    });
    await runFinalReview(makeOpts(), deps);

    expect(reviewAgent.send).toHaveBeenCalledTimes(1);
  });

  it('bounds review-fix cycle at maxReviewCycles', async () => {
    const auditAgent = makeAgent([
      makeResult({ assistantText: 'Found issue' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
    ]);
    const reviewResult = makeResult({ assistantText: 'Still issues', sessionId: 'sess-review' });
    const reviewAgent = makeAgent(Array(5).fill(reviewResult));
    const implAgent = makeAgent(Array(5).fill(makeResult()));

    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
      reviewAgent,
      implAgent,
      extractFindings: vi.fn().mockReturnValue('Still issues'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    await runFinalReview(makeOpts({ maxReviewCycles: 2 }), deps);

    // impl: 1 audit fix + 2 review fixes = 3
    expect(implAgent.send).toHaveBeenCalledTimes(3);
    expect(reviewAgent.send).toHaveBeenCalledTimes(2);
  });

  it('logs and skips pass when audit agent fails', async () => {
    const callCount = { n: 0 };
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockImplementation(() => {
        callCount.n++;
        // First audit fails, others clean
        if (callCount.n === 1) return makeAgent([makeResult({ exitCode: 1, assistantText: 'error' })]);
        return makeAgent();
      }),
    });
    await runFinalReview(makeOpts(), deps);

    expect(deps.implAgent.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('audit agent failure'));
    expect(deps.createAuditAgent).toHaveBeenCalledTimes(3);
  });

  it('classifies deliberate rejection when fix makes no changes with exit 0', async () => {
    const auditAgent = makeAgent([
      makeResult({ assistantText: 'Found issue' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
    ]);
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult]);
    const implAgent = makeAgent([makeResult(), makeResult({ exitCode: 0 })]);

    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
      reviewAgent,
      implAgent,
      extractFindings: vi.fn().mockReturnValue('Found issue'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn()
        .mockResolvedValueOnce(true)   // run baseline check
        .mockResolvedValueOnce(true)   // review entry
        .mockResolvedValueOnce(false), // no changes after fix
    });
    await runFinalReview(makeOpts(), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('deliberate'));
    expect(reviewAgent.send).toHaveBeenCalledTimes(1);
  });

  it('logs execution failure when fix has non-zero exit', async () => {
    const auditAgent = makeAgent([
      makeResult({ assistantText: 'Found issue' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
    ]);
    const reviewResult = makeResult({ assistantText: 'Found issue', sessionId: 'sess-review' });
    const reviewAgent = makeAgent([reviewResult, reviewResult]);
    const implAgent = makeAgent([makeResult(), makeResult({ exitCode: 1 })]);

    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
      reviewAgent,
      implAgent,
      extractFindings: vi.fn().mockReturnValue('Found issue'),
      isCleanReview: vi.fn().mockReturnValue(false),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    await runFinalReview(makeOpts({ maxReviewCycles: 2 }), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('failure'));
  });

  it('processes all three passes sequentially even when first has findings', async () => {
    const callCount = { n: 0 };
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockImplementation(() => {
        callCount.n++;
        if (callCount.n === 1) return makeAgent([makeResult({ assistantText: 'Type issue' })]);
        if (callCount.n === 2) return makeAgent([makeResult({ assistantText: 'Missing impl' })]);
        return makeAgent([makeResult({ assistantText: 'NO_ISSUES_FOUND' })]);
      }),
    });
    await runFinalReview(makeOpts(), deps);

    expect(deps.createAuditAgent).toHaveBeenCalledTimes(3);
    // Two passes had findings = 2 impl fix calls
    expect(deps.implAgent.send).toHaveBeenCalledTimes(2);
  });

  it('skips review loop when maxReviewCycles is 0', async () => {
    const auditAgent = makeAgent([
      makeResult({ assistantText: 'Found issue' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
      makeResult({ assistantText: 'NO_ISSUES_FOUND' }),
    ]);
    const deps = makeDeps({
      createAuditAgent: vi.fn().mockReturnValue(auditAgent),
      hasChanges: vi.fn().mockResolvedValue(true),
    });
    await runFinalReview(makeOpts({ maxReviewCycles: 0 }), deps);

    expect(deps.reviewAgent.send).not.toHaveBeenCalled();
    expect(deps.implAgent.send).toHaveBeenCalledTimes(1); // only audit fix
  });
});
