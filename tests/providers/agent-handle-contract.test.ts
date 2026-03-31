import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentSpawner, AgentHandle } from '../../src/application/ports/agent-spawner.port.js';
import { ClaudeAgentSpawner } from '../../src/infrastructure/claude-agent-spawner.js';
import { CodexAgentSpawner } from '../../src/infrastructure/codex/codex-agent-spawner.js';
import { createFakeAppServer, type FakeAppServer } from '../codex/fake-app-server.js';

// --- Claude mock setup ---

vi.mock('../../src/infrastructure/claude/claude-agent-factory.js', () => {
  const createMockHandle = (sessionId: string) => {
    let alive = true;
    return {
      send: vi.fn().mockResolvedValue({
        exitCode: 0,
        assistantText: 'hello',
        resultText: 'ok',
        needsInput: false,
        sessionId,
      }),
      sendQuiet: vi.fn().mockResolvedValue('quiet result'),
      inject: vi.fn(),
      kill: vi.fn(() => { alive = false; }),
      pipe: vi.fn(),
      get alive() { return alive; },
      stderr: '',
      sessionId,
      style: { label: 'TDD', color: '', badge: '' },
    };
  };

  return {
    spawnClaudeAgent: vi.fn((_style, _prompt, resumeId) =>
      createMockHandle(resumeId ?? 'claude-sess-1'),
    ),
    spawnClaudePlanAgent: vi.fn((_style, _prompt, _cwd) =>
      createMockHandle('claude-plan-sess'),
    ),
  };
});

// --- Contract suite ---

const describeAgentHandleContract = (
  name: string,
  setup: () => { spawner: AgentSpawner; beforeSend?: () => void; teardown: () => void },
) => {
  describe(`AgentHandle contract: ${name}`, () => {
    let spawner: AgentSpawner;
    let teardown: () => void;
    let beforeSend: (() => void) | undefined;

    afterEach(() => {
      teardown?.();
    });

    const init = () => {
      const ctx = setup();
      spawner = ctx.spawner;
      teardown = ctx.teardown;
      beforeSend = ctx.beforeSend;
    };

    it('sessionId is a non-empty string after spawn + send', async () => {
      init();
      const handle = spawner.spawn('tdd');
      beforeSend?.();
      await handle.send('init');
      expect(handle.sessionId).toBeTruthy();
      expect(typeof handle.sessionId).toBe('string');
    });

    it('send() returns AgentResult with non-empty resultText', async () => {
      init();
      const handle = spawner.spawn('tdd');
      beforeSend?.();
      const result = await handle.send('test prompt');
      expect(result.resultText).toBeTruthy();
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBeTruthy();
    });

    it('sendQuiet() returns a non-empty string', async () => {
      init();
      const handle = spawner.spawn('tdd');
      beforeSend?.();
      const text = await handle.sendQuiet('quiet prompt');
      expect(text).toBeTruthy();
      expect(typeof text).toBe('string');
    });

    it('inject() between turns does not throw', async () => {
      init();
      const handle = spawner.spawn('tdd');
      beforeSend?.();
      await handle.send('first');
      expect(() => handle.inject('guidance')).not.toThrow();
    });

    it('kill() sets alive to false', async () => {
      init();
      const handle = spawner.spawn('tdd');
      beforeSend?.();
      await handle.send('init');
      expect(handle.alive).toBe(true);
      handle.kill();
      expect(handle.alive).toBe(false);
    });

    it('resumed session preserves sessionId', async () => {
      init();
      const handle = spawner.spawn('tdd', { resumeSessionId: 'prev-session' });
      beforeSend?.();
      await handle.send('init');
      expect(handle.sessionId).toBe('prev-session');
    });
  });
};

// --- Claude provider ---

describeAgentHandleContract('ClaudeAgentSpawner', () => ({
  spawner: new ClaudeAgentSpawner({}, '/tmp/test'),
  teardown: () => {},
}));

// --- Codex provider ---

let codexFake: FakeAppServer | undefined;

describeAgentHandleContract('CodexAgentSpawner', () => {
  const fake = createFakeAppServer();
  codexFake = fake;
  fake.setTurnScript([
    { kind: 'textDelta', text: 'hello' },
    { kind: 'turnCompleted', resultText: 'done' },
  ]);
  return {
    spawner: new CodexAgentSpawner(
      '/tmp/test',
      { auto: false, noInteraction: false },
      () => fake.proc,
    ),
    beforeSend: () => {
      // Re-set the turn script before each send so it's available
      fake.setTurnScript([
        { kind: 'textDelta', text: 'hello' },
        { kind: 'turnCompleted', resultText: 'done' },
      ]);
    },
    teardown: () => {
      fake.close();
      codexFake = undefined;
    },
  };
});
