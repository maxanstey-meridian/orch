import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeAppServer, type FakeAppServer } from './fake-app-server.js';
import { CodexAgentSpawner } from '../../src/infrastructure/codex/codex-agent-spawner.js';

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('CodexAgentSpawner', () => {
  let fake: FakeAppServer;

  afterEach(() => {
    fake?.close();
  });

  it('spawn with no resumeSessionId calls thread/start and sessionId is the thread id', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');

    // sessionId is not available synchronously — need to await ready via send
    fake.setTurnScript([{ kind: 'turnCompleted', resultText: '' }]);
    await handle.send('init');

    const threadStart = fake.receivedRequests.find((r) => r.method === 'thread/start');
    expect(threadStart).toBeDefined();
    // sessionId must be the real thread id returned by the server, not a UUID
    expect(handle.sessionId).toMatch(/^thread-/);
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

  it('currentTurnId is defined during an active turn', async () => {
    const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
    const fake2 = createFakeAppServer();
    const client = createCodexAppServerClient(fake2.proc);
    await client.initialize();
    await client.startThread();

    fake2.setTurnScript([
      { kind: 'textDelta', text: 'hello' },
      { kind: 'turnCompleted', resultText: 'done' },
    ]);

    // Before turn: no turnId
    expect(client.currentTurnId).toBeUndefined();

    let capturedTurnId: string | undefined;
    await client.startTurn('go', (event) => {
      if (event.kind === 'textDelta') {
        capturedTurnId = client.currentTurnId;
      }
    });

    // During turn, currentTurnId was defined
    expect(capturedTurnId).toBeDefined();
    expect(typeof capturedTurnId).toBe('string');
    // After turn completes, currentTurnId is cleared
    expect(client.currentTurnId).toBeUndefined();

    fake2.close();
  });

  it('alive becomes false when process dies unexpectedly', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');

    fake.setTurnScript([{ kind: 'turnCompleted', resultText: '' }]);
    await handle.send('init');

    expect(handle.alive).toBe(true);

    // Simulate process death by ending stdout
    fake.stdout.push(null);
    await new Promise((r) => setTimeout(r, 10));

    expect(handle.alive).toBe(false);
  });

  it('send() resolves with exitCode 1 when process dies mid-turn', async () => {
    fake = createFakeAppServer();
    fake.hangOnTurn();
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');

    // Wait for ready (initialize + thread/start)
    await new Promise((r) => setTimeout(r, 10));

    const sendPromise = handle.send('will die');

    // Simulate process death
    await new Promise((r) => setTimeout(r, 5));
    fake.stdout.push(null);

    const result = await sendPromise;
    expect(result.exitCode).toBe(1);
    expect(result.resultText).toBe('');
    expect(result.sessionId).toBe(handle.sessionId);
  });

  it('sendQuiet() returns empty string when process dies mid-turn', async () => {
    fake = createFakeAppServer();
    fake.hangOnTurn();
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');

    await new Promise((r) => setTimeout(r, 10));

    const sendPromise = handle.sendQuiet('will die');
    await new Promise((r) => setTimeout(r, 5));
    fake.stdout.push(null);

    const result = await sendPromise;
    expect(result).toBe('');
  });

  it('startTurn emits exactly one turnCompleted even if server sends turn/completed as notification', async () => {
    const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
    const fake2 = createFakeAppServer();
    const client = createCodexAppServerClient(fake2.proc);
    await client.initialize();
    await client.startThread();

    // Manually script: server sends turn/completed as notification AND as RPC response
    // This simulates the worst case where both paths fire
    fake2.setTurnScript([
      { kind: 'textDelta', text: 'hello' },
    ]);
    // Override: after normal script runs, also send a turn/completed notification manually
    // We need to do this at a lower level — push a notification directly to stdout
    const turnPromise = (async () => {
      // Wait for turn/start request to arrive
      await new Promise((r) => setTimeout(r, 5));
      // Send a turn/completed notification (no id — it's a notification)
      fake2.stdout.push(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { result: 'from notification' } }) + '\n');
      // Then the fake already sends the RPC response with result from the script
    })();

    const events: Array<{ kind: string; resultText?: string }> = [];
    await client.startTurn('go', (event) => {
      if (event.kind === 'turnCompleted') {
        events.push({ kind: event.kind, resultText: (event as { resultText: string }).resultText });
      } else {
        events.push({ kind: event.kind });
      }
    });
    await turnPromise;

    const turnCompletedCount = events.filter((e) => e.kind === 'turnCompleted').length;
    expect(turnCompletedCount).toBe(1);

    fake2.close();
  });

  it('send() returns exitCode 1 and error text when turnFailed arrives', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'textDelta', text: 'partial' },
      { kind: 'turnFailed', error: { code: 'serverOverloaded', message: 'Server is overloaded' } },
      { kind: 'turnCompleted', resultText: '' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', () => fake.proc);
    const handle = spawner.spawn('tdd');

    const result = await handle.send('go');

    expect(result.exitCode).toBe(1);
    expect(result.assistantText).toContain('serverOverloaded');
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
