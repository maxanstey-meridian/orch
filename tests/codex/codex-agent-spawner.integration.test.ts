import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { createCodexAppServerClient, type CodexAppServerClient } from '../../src/infrastructure/codex/codex-app-server-client.js';
import { CodexAgentSpawner } from '../../src/infrastructure/codex/codex-agent-spawner.js';
import type { CodexEvent } from '../../src/infrastructure/codex/codex-notifications.js';

const hasCodex = (() => {
  try {
    execSync('which codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const spawnAppServer = () =>
  spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });

describe.skipIf(!hasCodex)('CodexAgentSpawner integration (real codex binary)', () => {
  let client: CodexAppServerClient | undefined;
  let proc: ReturnType<typeof spawn> | undefined;

  afterEach(() => {
    client?.close();
    client = undefined;
    proc?.kill();
    proc = undefined;
  });

  it('app-server initialize handshake succeeds', async () => {
    proc = spawnAppServer();
    client = createCodexAppServerClient(proc);
    await expect(client.initialize()).resolves.toBeUndefined();
  }, 15_000);

  it('thread/start returns a non-empty thread id', async () => {
    proc = spawnAppServer();
    client = createCodexAppServerClient(proc);
    await client.initialize();
    const threadId = await client.startThread();
    expect(threadId).toBeTruthy();
    expect(typeof threadId).toBe('string');
  }, 15_000);

  it('turn/start with trivial prompt completes without error', async () => {
    proc = spawnAppServer();
    client = createCodexAppServerClient(proc);
    await client.initialize();
    await client.startThread();

    const events: CodexEvent[] = [];
    const result = await client.startTurn('Respond with exactly: hello', (e) => {
      events.push(e);
    });

    expect(typeof result).toBe('string');
  }, 60_000);

  // thread/resume depends on server-side rollout persistence. The codex app-server
  // returns "no rollout found" even within the same process — likely a timing issue
  // where the rollout file isn't flushed before resume is called. Enable this test
  // when codex app-server supports immediate resume after thread/start.
  it.todo('thread/resume works within the same process');

  it('kill() on spawned handle does not crash the process', async () => {
    const spawner = new CodexAgentSpawner(
      process.cwd(),
      { auto: true, noInteraction: false },
      spawnAppServer,
    );
    const handle = spawner.spawn('tdd');

    // Complete one turn to ensure the session is fully initialized
    const result = await handle.send('Say hello');
    expect(result.exitCode).toBeDefined();

    // Kill the handle — should not throw
    expect(() => handle.kill()).not.toThrow();
    expect(handle.alive).toBe(false);
  }, 60_000);

  it('auto-approve mode completes tool-using turn without deadlock', async () => {
    const spawner = new CodexAgentSpawner(
      process.cwd(),
      { auto: true, noInteraction: false },
      spawnAppServer,
    );
    const handle = spawner.spawn('tdd');

    try {
      const result = await handle.send('List the files in the current directory');
      expect(result.exitCode).toBeDefined();
      expect(typeof result.resultText).toBe('string');
    } finally {
      handle.kill();
    }
  }, 60_000);
});
