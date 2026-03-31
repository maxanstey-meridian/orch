import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeAppServer, type FakeAppServer } from './fake-app-server.js';
import { CodexAgentSpawner } from '../../src/infrastructure/codex/codex-agent-spawner.js';

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('CodexAgentSpawner', () => {
  let fake: FakeAppServer;

  afterEach(() => {
    fake?.close();
  });

  it('spawn with no resumeSessionId calls thread/start and sets sessionId', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');

    await tick();

    const threadStart = fake.receivedRequests.find((r) => r.method === 'thread/start');
    expect(threadStart).toBeDefined();
    expect(handle.sessionId).toBeTruthy();
  });

  it('send() resolves with AgentResult on turnCompleted', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'textDelta', text: 'hello' },
      { kind: 'turnCompleted', resultText: 'final result' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');

    const result = await handle.send('do something');

    expect(result.resultText).toBe('final result');
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(handle.sessionId);
    expect(result.assistantText).toContain('hello');
  });

  it('send() calls onText for each text delta in order', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'textDelta', text: 'one' },
      { kind: 'textDelta', text: 'two' },
      { kind: 'turnCompleted', resultText: 'done' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');
    const onText = vi.fn();

    await handle.send('go', onText);

    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText.mock.calls[0][0]).toBe('one');
    expect(onText.mock.calls[1][0]).toBe('two');
  });

  it('send() calls onToolUse for tool activity events', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'toolActivity', summary: 'command: npm test' },
      { kind: 'turnCompleted', resultText: 'done' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');
    const onToolUse = vi.fn();

    await handle.send('go', undefined, onToolUse);

    expect(onToolUse).toHaveBeenCalledWith('command: npm test');
  });

  it('sendQuiet() returns resultText without streaming callbacks', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'textDelta', text: 'ignored' },
      { kind: 'turnCompleted', resultText: 'the answer' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');
    const onText = vi.fn();
    const onToolUse = vi.fn();
    handle.pipe(onText, onToolUse);

    const text = await handle.sendQuiet('question');

    expect(text).toBe('the answer');
    expect(onText).not.toHaveBeenCalled();
    expect(onToolUse).not.toHaveBeenCalled();
  });

  it('pipe() callbacks invoked when send() has no per-call callbacks', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'textDelta', text: 'streamed' },
      { kind: 'toolActivity', summary: 'command: test' },
      { kind: 'turnCompleted', resultText: 'done' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');
    const onText = vi.fn();
    const onToolUse = vi.fn();
    handle.pipe(onText, onToolUse);

    await handle.send('go');

    expect(onText).toHaveBeenCalledWith('streamed');
    expect(onToolUse).toHaveBeenCalledWith('command: test');
  });

  it('spawn with planMode and systemPrompt passes developerInstructions to thread/start', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    spawner.spawn('plan', { planMode: true, systemPrompt: 'plan instructions' });

    await tick();

    const threadStart = fake.receivedRequests.find((r) => r.method === 'thread/start');
    expect(threadStart).toBeDefined();
    expect(threadStart!.params?.developerInstructions).toBe('plan instructions');
  });

  it('spawn with resumeSessionId calls thread/resume with that id', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd', { resumeSessionId: 'prev-thread' });

    await tick();

    const threadResume = fake.receivedRequests.find((r) => r.method === 'thread/resume');
    expect(threadResume).toBeDefined();
    expect(threadResume!.params?.threadId).toBe('prev-thread');
    expect(handle.sessionId).toBe('prev-thread');
  });
});
