import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runAgent, runAgentQuiet } from './agent.js';

const makeScript = async (dir: string, name: string, body: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-agent-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('runAgent', () => {
  it('parses assistant and result events into structured result', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world."}]}}\'',
      'echo \'{"type":"result","result":"Done.","duration_ms":1500,"num_turns":2}\'',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'test prompt',
      command: script,
      args: [],
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.assistantText).toBe('Hello world.');
    expect(result.resultText).toBe('Done.');
    expect(result.needsInput).toBe(false);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses provided session ID when resuming', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'test',
      command: script,
      args: [],
      sessionId: 'existing-session-123',
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.sessionId).toBe('existing-session-123');
  });

  it('accumulates text from multiple assistant events', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"First block. "}]}}\'',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"Second block."}]}}\'',
      'echo \'{"type":"result","result":"done","duration_ms":100,"num_turns":1}\'',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'test',
      command: script,
      args: [],
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.assistantText).toBe('First block. Second block.');
  });

  it('silently ignores malformed JSON lines', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'echo "not json at all"',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"good line"}]}}\'',
      'echo "{broken json"',
      'echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'test',
      command: script,
      args: [],
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.assistantText).toBe('good line');
    expect(result.resultText).toBe('ok');
  });

  it('sets needsInput when assistant text ends with a question', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"Should I proceed with this?"}]}}\'',
      'echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'test',
      command: script,
      args: [],
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.needsInput).toBe(true);
  });

  it('ignores structurally invalid assistant events', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'echo \'{"type":"assistant","message":"not-an-object"}\'',
      'echo \'{"type":"assistant","message":{"content":"not-an-array"}}\'',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"valid"}]}}\'',
      'echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'test',
      command: script,
      args: [],
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.assistantText).toBe('valid');
  });

  it('passes prompt to child process as argument', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      '# Echo the last argument as assistant text to prove we received it',
      'PROMPT="$1"',
      'echo "{\\\"type\\\":\\\"assistant\\\",\\\"message\\\":{\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"got: ${PROMPT}\\\"}]}}"',
      'echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'my test prompt',
      command: script,
      args: [],
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.assistantText).toBe('got: my test prompt');
  });

  it('captures non-zero exit code when process fails', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"partial output"}]}}\'',
      'exit 2',
    ].join('\n'));

    const result = await runAgent({
      prompt: 'test',
      command: script,
      args: [],
      style: { label: 'impl', color: 'cyan', badge: 'I' },
    });

    expect(result.exitCode).toBe(2);
    expect(result.assistantText).toBe('partial output');
    expect(result.resultText).toBe('');
  });
});

describe('runAgentQuiet', () => {
  it('extracts result text from JSON output', async () => {
    const script = await makeScript(tempDir, 'quiet.sh', [
      'echo \'{"type":"result","result":"summary text here","duration_ms":50,"num_turns":1}\'',
    ].join('\n'));

    const result = await runAgentQuiet({
      prompt: 'summarize',
      command: script,
      args: [],
      sessionId: 'session-1',
    });

    expect(result).toBe('summary text here');
  });
});
