import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeAppServer, type FakeAppServer } from './fake-app-server.js';
import { CodexAgentSpawner } from '../../src/infrastructure/codex/codex-agent-spawner.js';
import { SilentRuntimeInteractionGate } from '../../src/ui/ink-runtime-interaction-gate.js';
import type { RuntimeInteractionGate } from '../../src/application/ports/runtime-interaction.port.js';

const tick = () => new Promise((r) => setTimeout(r, 10));
const silentGate = new SilentRuntimeInteractionGate();

const extractPrompt = (params?: Record<string, unknown>): string => {
  const input = params?.input as ReadonlyArray<{ text: string }> | undefined;
  return input?.[0]?.text ?? '';
};

describe('CodexAgentSpawner', () => {
  let fake: FakeAppServer;

  afterEach(() => {
    fake?.close();
  });


  it('spawn with no resumeSessionId calls thread/start and sessionId is the thread id', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
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
      { kind: 'textDelta', text: 'hello ' },
      { kind: 'textDelta', text: 'world' },
      { kind: 'turnCompleted', resultText: '' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
    const handle = spawner.spawn('tdd');

    const result = await handle.send('do something');

    expect(result.resultText).toBe('hello world');
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(handle.sessionId);
    expect(result.assistantText).toContain('hello');
  });

  it('send() calls onText with buffered text deltas', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'textDelta', text: 'line one\n' },
      { kind: 'textDelta', text: 'line two\n' },
      { kind: 'turnCompleted', resultText: '' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
    const handle = spawner.spawn('tdd');
    const onText = vi.fn();

    await handle.send('go', onText);

    const allText = onText.mock.calls.map((c) => c[0]).join('');
    expect(allText).toContain('line one');
    expect(allText).toContain('line two');
  });

  it('send() calls onToolUse for tool activity events', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'toolActivity', summary: 'command: npm test' },
      { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
    const handle = spawner.spawn('tdd');
    const onToolUse = vi.fn();

    await handle.send('go', undefined, onToolUse);

    expect(onToolUse).toHaveBeenCalledWith('command: npm test');
  });

  it('sendQuiet() returns resultText without streaming callbacks', async () => {
    fake = createFakeAppServer();
    fake.setTurnScript([
      { kind: 'textDelta', text: 'the answer' },
      { kind: 'turnCompleted', resultText: '' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
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
      { kind: 'textDelta', text: 'streamed\n' },
      { kind: 'toolActivity', summary: 'command: test' },
      { kind: 'turnCompleted', resultText: '' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
    const handle = spawner.spawn('tdd');
    const onText = vi.fn();
    const onToolUse = vi.fn();
    handle.pipe(onText, onToolUse);

    await handle.send('go');

    const allText = onText.mock.calls.map((c) => c[0]).join('');
    expect(allText).toContain('streamed');
    expect(onToolUse).toHaveBeenCalledWith('command: test');
  });

  it('spawn with planMode and systemPrompt passes developerInstructions to thread/start', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
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
    fake2.stallTurnAfterStart();

    // Before turn: no turnId
    expect(client.currentTurnId).toBeUndefined();

    const turnPromise = client.startTurn('go', () => {}).catch(() => {});
    await tick();

    // During turn, currentTurnId was defined
    expect(client.currentTurnId).toBe(fake2.lastTurnId);
    // After turn completes, currentTurnId is cleared
    fake2.close();
    await turnPromise;
    expect(client.currentTurnId).toBeUndefined();
  });

  it('alive becomes false when process dies unexpectedly', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
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
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
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
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
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
      { kind: 'turnFailed', message: 'Server is overloaded' },
      { kind: 'turnCompleted', resultText: '' },
    ]);
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
    const handle = spawner.spawn('tdd');

    const result = await handle.send('go');

    expect(result.exitCode).toBe(1);
    expect(result.assistantText).toContain('Server is overloaded');
    expect(result.resultText).toContain('Server is overloaded');
  });

  describe('steerTurn and interruptTurn', () => {
    it('steerTurn sends turn/steer RPC during active turn', async () => {
      const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
      const fake2 = createFakeAppServer();
      fake2.stallTurnAfterStart();
      const client = createCodexAppServerClient(fake2.proc);
      await client.initialize();
      await client.startThread();

      // Start turn (will hang — not awaited). Catch rejection on close.
      const turnPromise = client.startTurn('go', () => {}).catch(() => {});
      await tick();

      await client.steerTurn('fix the types');

      const steer = fake2.receivedRequests.find((r) => r.method === 'turn/steer');
      expect(steer).toBeDefined();
      expect(steer!.params?.message).toBe('fix the types');
      expect(steer!.params?.threadId).toBe(client.threadId);
      expect(steer!.params?.turnId).toBe(fake2.lastTurnId);

      fake2.close();
      await turnPromise;
    });

    it('steerTurn throws when no active turn', async () => {
      const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
      const fake2 = createFakeAppServer();
      const client = createCodexAppServerClient(fake2.proc);
      await client.initialize();
      await client.startThread();

      await expect(client.steerTurn('msg')).rejects.toThrow();

      fake2.close();
    });

    it('interruptTurn sends turn/interrupt RPC during active turn', async () => {
      const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
      const fake2 = createFakeAppServer();
      fake2.stallTurnAfterStart();
      const client = createCodexAppServerClient(fake2.proc);
      await client.initialize();
      await client.startThread();

      const turnPromise = client.startTurn('go', () => {}).catch(() => {});
      await tick();

      await client.interruptTurn();

      const interrupt = fake2.receivedRequests.find((r) => r.method === 'turn/interrupt');
      expect(interrupt).toBeDefined();
      expect(interrupt!.params?.threadId).toBe(client.threadId);
      expect(interrupt!.params?.turnId).toBe(fake2.lastTurnId);

      fake2.close();
      await turnPromise;
    });

    it('interruptTurn throws when no active turn', async () => {
      const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
      const fake2 = createFakeAppServer();
      const client = createCodexAppServerClient(fake2.proc);
      await client.initialize();
      await client.startThread();

      await expect(client.interruptTurn()).rejects.toThrow();

      fake2.close();
    });
  });

  describe('inject and kill', () => {
    it('inject() during active turn sends turn/steer', async () => {
      fake = createFakeAppServer();
      fake.stallTurnAfterStart();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick(); // wait for ready

      const sendPromise = handle.send('prompt').catch(() => {});
      await tick(); // wait for turn to be active

      handle.inject('fix the types');
      await tick();

      const steer = fake.receivedRequests.find((r) => r.method === 'turn/steer');
      expect(steer).toBeDefined();
      expect(steer!.params?.message).toBe('fix the types');
      expect(steer!.params?.turnId).toBe(fake.lastTurnId);

      handle.kill();
      await sendPromise;
    });

    it('inject() between turns queues the message (no RPC sent)', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick(); // wait for ready

      handle.inject('guidance 1');
      await tick();

      const steer = fake.receivedRequests.find((r) => r.method === 'turn/steer');
      expect(steer).toBeUndefined();
    });

    it('queued guidance prepended to next send()', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick();

      handle.inject('guidance A');
      handle.inject('guidance B');

      fake.setTurnScript([{ kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' }]);
      await handle.send('do the thing');

      const turnStart = fake.receivedRequests.filter((r) => r.method === 'turn/start');
      const prompt = extractPrompt(turnStart[0]?.params);
      expect(prompt).toContain('guidance A');
      expect(prompt).toContain('guidance B');
      expect(prompt).toContain('do the thing');
      // Guidance appears before the actual prompt
      expect(prompt.indexOf('guidance A')).toBeLessThan(prompt.indexOf('do the thing'));
    });

    it('multiple queued messages appear in insertion order', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick();

      handle.inject('first');
      handle.inject('second');

      fake.setTurnScript([{ kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' }]);
      await handle.send('go');

      const turnStart = fake.receivedRequests.filter((r) => r.method === 'turn/start');
      const prompt = extractPrompt(turnStart[0]?.params);
      expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('second'));
    });

    it('queue is cleared after flush', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick();

      handle.inject('one-time guidance');
      fake.setTurnScript([{ kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' }]);
      await handle.send('first send');

      // Second send should have no guidance
      fake.setTurnScript([{ kind: 'textDelta', text: 'done2' }, { kind: 'turnCompleted', resultText: '' }]);
      await handle.send('second send');

      const turnStarts = fake.receivedRequests.filter((r) => r.method === 'turn/start');
      const secondPrompt = extractPrompt(turnStarts[1]?.params);
      expect(secondPrompt).toBe('second send');
    });

    it('kill() during active turn sends interrupt then closes', async () => {
      fake = createFakeAppServer();
      fake.stallTurnAfterStart();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick();

      const sendPromise = handle.send('prompt').catch(() => {});
      await tick();

      handle.kill();
      await tick();

      const interrupt = fake.receivedRequests.find((r) => r.method === 'turn/interrupt');
      expect(interrupt).toBeDefined();
      expect(interrupt!.params?.turnId).toBe(fake.lastTurnId);
      expect(handle.alive).toBe(false);

      await sendPromise;
    });

    it('kill() while idle closes without interrupt', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick();

      handle.kill();
      await tick();

      const interrupt = fake.receivedRequests.find((r) => r.method === 'turn/interrupt');
      expect(interrupt).toBeUndefined();
      expect(handle.alive).toBe(false);
    });

    it('after kill(), alive is false', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick();

      handle.kill();

      expect(handle.alive).toBe(false);
    });
  });

  it('spawn with resumeSessionId calls thread/resume with that id', async () => {
    fake = createFakeAppServer();
    const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
    const handle = spawner.spawn('tdd', { resumeSessionId: 'prev-thread' });

    await tick();

    const threadResume = fake.receivedRequests.find((r) => r.method === 'thread/resume');
    expect(threadResume).toBeDefined();
    expect(threadResume!.params?.threadId).toBe('prev-thread');
    expect(handle.sessionId).toBe('prev-thread');
  });

  describe('mode config and sandbox', () => {
    it('plan role passes read-only sandbox to thread/start', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      spawner.spawn('plan');

      await tick();

      const threadStart = fake.receivedRequests.find((r) => r.method === 'thread/start');
      expect(threadStart!.params?.sandbox).toBe('read-only');
    });

    it('tdd role passes workspace-write sandbox to thread/start', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      spawner.spawn('tdd');

      await tick();

      const threadStart = fake.receivedRequests.find((r) => r.method === 'thread/start');
      expect(threadStart!.params?.sandbox).toBe('workspace-write');
    });

    it('auto-approve mode auto-approves approval events during turn', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-1', kind: 'command', summary: 'run npm test' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: true }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');

      expect(result.resultText).toBe('done');
      // Check that an approval response was sent
      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      // id is the JSON-RPC server request id, not the event itemId;
      expect((approvalResponse!.result as any)?.decision).toBe('accept');
    });

    it('sendQuiet() auto-approves approval events in auto-approve mode', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-q1', kind: 'command', summary: 'run npm test' } },
        { kind: 'textDelta', text: 'quiet result' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: true }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const text = await handle.sendQuiet('go');

      expect(text).toBe('quiet result');
      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      // id is the JSON-RPC server request id;
      expect((approvalResponse!.result as any)?.decision).toBe('accept');
    });

    it('resumed session passes sandbox to thread/resume', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      spawner.spawn('plan', { resumeSessionId: 'prev-thread' });

      await tick();

      const threadResume = fake.receivedRequests.find((r) => r.method === 'thread/resume');
      expect(threadResume!.params?.sandbox).toBe('read-only');
    });

    it('interactive mode routes approval through gate (not auto-approve)', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-1', kind: 'command', summary: 'run npm test' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await handle.send('go');
      await tick();

      // Gate was consulted (not bypassed like auto-approve mode)
      expect(gate.decide).toHaveBeenCalledOnce();
      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      expect((approvalResponse!.result as any)?.decision).toBe('accept');
    });
  });

  describe('approval routing', () => {
    it('approval request triggers gate.decide() in interactive mode', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-1', kind: 'command', summary: 'run npm test' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await handle.send('go');
      await tick();

      expect(gate.decide).toHaveBeenCalledWith({
        kind: 'commandApproval',
        summary: 'run npm test',
        command: 'run npm test',
      });
    });

    it('approved decision sends approval response', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-1', kind: 'command', summary: 'run npm test' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await handle.send('go');
      await tick();

      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      // id is the JSON-RPC server request id, not the event itemId;
      expect((approvalResponse!.result as any)?.decision).toBe('accept');
    });

    it('rejected decision sends rejection response', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-2', kind: 'command', summary: 'rm -rf /' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'reject' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await handle.send('go');
      await tick();

      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      // id is the JSON-RPC server request id;
      expect((approvalResponse!.result as any)?.decision).toBe('cancel');
    });

    it('cancel decision interrupts turn', async () => {
      fake = createFakeAppServer();
      fake.stallTurnAfterStart();
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'cancel' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await tick();

      // Start the turn (it will hang — not resolved)
      const sendPromise = handle.send('go').catch(() => {});
      await tick();

      // Now emit an approval request into the hanging turn
      fake.stdout.push(JSON.stringify({
        jsonrpc: '2.0',
        method: 'codex/approvalRequest',
        params: { id: 'req-cancel', kind: 'command', summary: 'dangerous op' },
      }) + '\n');
      await tick();
      await tick();

      const interrupt = fake.receivedRequests.find((r) => r.method === 'turn/interrupt');
      expect(interrupt).toBeDefined();

      handle.kill();
      await sendPromise;
    });

    it('legacy codex/approvalRequest sends codex/approvalResponse notification', async () => {
      fake = createFakeAppServer();
      fake.stallTurnAfterStart();
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await tick();

      const sendPromise = handle.send('go').catch(() => {});
      await tick();

      fake.stdout.push(JSON.stringify({
        jsonrpc: '2.0',
        method: 'codex/approvalRequest',
        params: { id: 'legacy-req', kind: 'command', summary: 'run npm test' },
      }) + '\n');
      await tick();
      await tick();

      const approvalResponse = fake.receivedNotifications.find(
        (n) => n.method === 'codex/approvalResponse',
      );
      expect(approvalResponse).toBeDefined();
      expect(approvalResponse!.params).toEqual({ id: 'legacy-req', approved: true });

      handle.kill();
      await sendPromise;
    });

    it('auto-approve mode bypasses gate entirely', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-auto', kind: 'command', summary: 'npm test' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: true }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await handle.send('go');
      await tick();

      expect(gate.decide).not.toHaveBeenCalled();
      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      expect((approvalResponse!.result as any)?.decision).toBe('accept');
    });

    it('multiple approvals in single turn handled sequentially', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-a', kind: 'command', summary: 'first' } },
        { kind: 'approvalRequested', request: { id: 'req-b', kind: 'command', summary: 'second' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const callOrder: string[] = [];
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockImplementation(async (req) => {
          callOrder.push(req.summary);
          // Add a small delay to the first call to verify serialization
          if (req.summary === 'first') {
            await new Promise((r) => setTimeout(r, 20));
          }
          return { kind: 'approve' };
        }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await handle.send('go');
      await tick();
      await tick();

      expect(gate.decide).toHaveBeenCalledTimes(2);
      // First call must complete before second starts
      expect(callOrder).toEqual(['first', 'second']);

      const approvalResponses = fake.receivedResponses;
      expect(approvalResponses).toHaveLength(2);
      expect((approvalResponses[0].result as any)?.decision).toBe('accept');
      expect((approvalResponses[1].result as any)?.decision).toBe('accept');
    });

    it('sendQuiet() routes approvals through gate in interactive mode', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-quiet', kind: 'command', summary: 'npm test' } },
        { kind: 'textDelta', text: 'quiet done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      const text = await handle.sendQuiet('go');
      await tick();

      expect(text).toBe('quiet done');
      expect(gate.decide).toHaveBeenCalledOnce();
      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      expect((approvalResponse!.result as any)?.decision).toBe('accept');
    });

    it('approval with different summary text passes summary through to gate', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-fc', kind: 'command', summary: 'Allow git index updates for git add' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      await handle.send('go');
      await tick();

      expect(gate.decide).toHaveBeenCalledWith({
        kind: 'commandApproval',
        summary: 'Allow git index updates for git add',
        command: 'Allow git index updates for git add',
      });
    });

    it('gate.decide() rejection sends rejection as fail-safe', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'approvalRequested', request: { id: 'req-err', kind: 'command', summary: 'bad op' } },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockRejectedValue(new Error('hud crashed')),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');
      await tick();
      await tick();

      // Turn should still complete (no unhandled rejection crash)
      expect(result.resultText).toBe('done');
      // Gate was called
      expect(gate.decide).toHaveBeenCalledOnce();
      // Fail-safe rejection should have been sent
      const approvalResponse = fake.receivedResponses.find(
        (r) => r.result != null,
      );
      expect(approvalResponse).toBeDefined();
      // id is the JSON-RPC server request id;
      expect((approvalResponse!.result as any)?.decision).toBe('cancel');
    });

    it('sendQuiet() with piped callbacks suppresses text streaming but routes approvals', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'textDelta', text: 'quiet result' },
        { kind: 'approvalRequested', request: { id: 'req-sq', kind: 'command', summary: 'npm test' } },
        { kind: 'turnCompleted', resultText: '' },
      ]);
      const gate: RuntimeInteractionGate = {
        decide: vi.fn().mockResolvedValue({ kind: 'approve' }),
      };
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, gate);
      const handle = spawner.spawn('tdd');

      const pipedOnText = vi.fn();
      const pipedOnToolUse = vi.fn();
      handle.pipe(pipedOnText, pipedOnToolUse);

      const text = await handle.sendQuiet('go');
      await tick();

      // Piped callbacks must not be called during sendQuiet
      expect(pipedOnText).not.toHaveBeenCalled();
      expect(pipedOnToolUse).not.toHaveBeenCalled();
      // But gate must have been called for the approval
      expect(gate.decide).toHaveBeenCalledOnce();
      expect(text).toBe('quiet result');
    });
  });

  describe('gap coverage', () => {
    it('sendQuiet() flushes pending guidance queue', async () => {
      fake = createFakeAppServer();
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      await tick();

      handle.inject('quiet guidance');

      fake.setTurnScript([{ kind: 'textDelta', text: 'quiet done' }, { kind: 'turnCompleted', resultText: '' }]);
      const text = await handle.sendQuiet('quiet prompt');

      expect(text).toBe('quiet done');
      const turnStart = fake.receivedRequests.filter((r) => r.method === 'turn/start');
      const prompt = extractPrompt(turnStart[0]?.params);
      expect(prompt).toContain('quiet guidance');
      expect(prompt).toContain('quiet prompt');
    });

    it('per-call onText overrides piped onText', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'textDelta', text: 'hello\n' },
        { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const pipedOnText = vi.fn();
      const pipedOnToolUse = vi.fn();
      handle.pipe(pipedOnText, pipedOnToolUse);

      const perCallOnText = vi.fn();
      await handle.send('go', perCallOnText);

      const allText = perCallOnText.mock.calls.map((c) => c[0]).join('');
      expect(allText).toContain('hello');
      expect(pipedOnText).not.toHaveBeenCalled();
    });

    it('send() sets needsInput true when assistant text ends with a question', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'textDelta', text: 'Should I proceed?' },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');

      expect(result.needsInput).toBe(true);
    });

    it('send() sets needsInput false when assistant text has no question', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'textDelta', text: 'All done.' },
        { kind: 'textDelta', text: 'done' }, { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');

      expect(result.needsInput).toBe(false);
    });

    it('turnFailed surfaces categorized error in resultText', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'turnFailed', message: 'overloaded' },
        { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');

      expect(result.exitCode).toBe(1);
      expect(result.resultText).toContain('overloaded');
    });

    it('credit-exhausted error is detectable by detectApiError', async () => {
      const { detectApiError } = await import('../../src/domain/api-errors.js');
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'turnFailed', message: "You've hit your usage limit" },
        { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');
      const apiError = detectApiError(result, '');

      expect(apiError).not.toBeNull();
      expect(apiError!.kind).toBe('credit-exhausted');
      expect(apiError!.retryable).toBe(false);
    });

    it('rate-limited error is detectable by detectApiError', async () => {
      const { detectApiError } = await import('../../src/domain/api-errors.js');
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'turnFailed', message: 'rate limit exceeded' },
        { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');
      const apiError = detectApiError(result, '');

      expect(apiError).not.toBeNull();
      expect(apiError!.kind).toBe('rate-limited');
      expect(apiError!.retryable).toBe(true);
    });

    it('overloaded error is detectable by detectApiError', async () => {
      const { detectApiError } = await import('../../src/domain/api-errors.js');
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'turnFailed', message: '529 overloaded' },
        { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');
      const apiError = detectApiError(result, '');

      expect(apiError).not.toBeNull();
      expect(apiError!.kind).toBe('overloaded');
      expect(apiError!.retryable).toBe(true);
    });

    it('initialize sends initialized notification to fake', async () => {
      const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
      const fake2 = createFakeAppServer();
      const client = createCodexAppServerClient(fake2.proc);

      await client.initialize();

      const initialized = fake2.receivedNotifications.find(
        (n) => n.method === 'initialized',
      );
      expect(initialized).toBeDefined();

      fake2.close();
    });

    it('send() does not include toolActivity summaries in assistantText', async () => {
      fake = createFakeAppServer();
      fake.setTurnScript([
        { kind: 'textDelta', text: 'hello' },
        { kind: 'toolActivity', summary: 'command: npm test' },
        { kind: 'turnCompleted', resultText: '' },
      ]);
      const spawner = new CodexAgentSpawner('/tmp/test', { auto: false }, () => fake.proc, silentGate);
      const handle = spawner.spawn('tdd');

      const result = await handle.send('go');

      expect(result.assistantText).toBe('hello');
      expect(result.assistantText).not.toContain('npm test');
    });

    it('respondToApproval does not throw when process is already dead', async () => {
      const { createCodexAppServerClient } = await import('../../src/infrastructure/codex/codex-app-server-client.js');
      const fake2 = createFakeAppServer();
      const client = createCodexAppServerClient(fake2.proc);
      await client.initialize();
      await client.startThread();

      // Kill the process
      client.close();
      await tick();

      // Should not throw
      expect(() => client.respondToApproval('req-1', true)).not.toThrow();

      fake2.close();
    });
  });
});
