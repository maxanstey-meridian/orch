import { describe, it, expect, vi } from 'vitest';
import { handleFollowUps, type FollowUpDeps } from './follow-up.js';
import type { AgentProcess, AgentResult } from './agent.js';

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: 'done',
  resultText: '',
  needsInput: false,
  sessionId: 'sess-1',
  ...overrides,
});

const makeDeps = (overrides: Partial<FollowUpDeps> = {}): FollowUpDeps => ({
  promptOperator: vi.fn().mockResolvedValue(''),
  ...overrides,
});

const makeAgent = (results: AgentResult[] = []): AgentProcess => {
  let callIndex = 0;
  return {
    send: vi.fn().mockImplementation(() => {
      const r = results[callIndex] ?? makeResult();
      callIndex++;
      return Promise.resolve(r);
    }),
    sendQuiet: vi.fn().mockResolvedValue(''),
    kill: vi.fn(),
    alive: true,
    sessionId: 'sess-1',
  };
};

describe('handleFollowUps', () => {
  it('returns original result immediately when needsInput is false', async () => {
    const result = makeResult({ needsInput: false });
    const deps = makeDeps();
    const agent = makeAgent();

    const final = await handleFollowUps({ agent, result, deps });

    expect(final).toBe(result);
    expect(deps.promptOperator).not.toHaveBeenCalled();
    expect(agent.send).not.toHaveBeenCalled();
  });

  it('returns original result immediately when interaction is disabled', async () => {
    const result = makeResult({ needsInput: true });
    const deps = makeDeps();
    const agent = makeAgent();

    const final = await handleFollowUps({ agent, result, deps, interactive: false });

    expect(final).toBe(result);
    expect(deps.promptOperator).not.toHaveBeenCalled();
  });

  it('prompts operator and relays response when agent needs input', async () => {
    const question = makeResult({ needsInput: true, assistantText: 'What should I do?' });
    const answer = makeResult({ needsInput: false, assistantText: 'Did the thing' });
    const deps = makeDeps({ promptOperator: vi.fn().mockResolvedValue('Do X') });
    const agent = makeAgent([answer]);

    const final = await handleFollowUps({ agent, result: question, deps });

    expect(deps.promptOperator).toHaveBeenCalledOnce();
    expect(agent.send).toHaveBeenCalledWith('Do X');
    expect(final).toBe(answer);
  });

  it('sends autonomy message when operator provides empty response', async () => {
    const question = makeResult({ needsInput: true });
    const answer = makeResult({ needsInput: false });
    const deps = makeDeps({ promptOperator: vi.fn().mockResolvedValue('') });
    const agent = makeAgent([answer]);

    await handleFollowUps({ agent, result: question, deps });

    const sentMessage = (agent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentMessage.length).toBeGreaterThan(0);
    expect(sentMessage).not.toBe('');
  });

  it('loops when agent asks another question after follow-up', async () => {
    const q1 = makeResult({ needsInput: true, assistantText: 'Question 1?' });
    const q2 = makeResult({ needsInput: true, assistantText: 'Question 2?' });
    const done = makeResult({ needsInput: false, assistantText: 'All done' });
    const deps = makeDeps({
      promptOperator: vi.fn()
        .mockResolvedValueOnce('Answer 1')
        .mockResolvedValueOnce('Answer 2'),
    });
    const agent = makeAgent([q2, done]);

    const final = await handleFollowUps({ agent, result: q1, deps });

    expect(deps.promptOperator).toHaveBeenCalledTimes(2);
    expect(agent.send).toHaveBeenCalledTimes(2);
    expect(final).toBe(done);
  });

  it('stops at max follow-ups and returns last result', async () => {
    const question = makeResult({ needsInput: true, assistantText: 'Question?' });
    const deps = makeDeps({ promptOperator: vi.fn().mockResolvedValue('Answer') });
    const agent = makeAgent([question, question, question, question]);

    const final = await handleFollowUps({ agent, result: question, deps, maxFollowUps: 2 });

    expect(deps.promptOperator).toHaveBeenCalledTimes(2);
    expect(agent.send).toHaveBeenCalledTimes(2);
    expect(final.needsInput).toBe(true);
  });

  it('uses default maxFollowUps of 3', async () => {
    const question = makeResult({ needsInput: true });
    const deps = makeDeps({ promptOperator: vi.fn().mockResolvedValue('Answer') });
    const agent = makeAgent([question, question, question, question]);

    const final = await handleFollowUps({ agent, result: question, deps });

    expect(deps.promptOperator).toHaveBeenCalledTimes(3);
    expect(agent.send).toHaveBeenCalledTimes(3);
  });

  it('returns failure result when agent process fails during relay', async () => {
    const question = makeResult({ needsInput: true });
    const failure = makeResult({ exitCode: 1, needsInput: false, assistantText: '' });
    const deps = makeDeps({ promptOperator: vi.fn().mockResolvedValue('Answer') });
    const agent = makeAgent([failure]);

    const final = await handleFollowUps({ agent, result: question, deps });

    expect(final).toBe(failure);
    expect(final.exitCode).toBe(1);
  });
});
