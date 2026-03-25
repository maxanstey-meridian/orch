import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractFindings, extractFormattedFindings } from './extract-findings.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-ef-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('extractFindings', () => {
  it('returns assistant text verbatim from agent result', () => {
    const result = {
      exitCode: 0,
      assistantText: '## Review\n\nFound 3 issues:\n1. Bug in parser\n2. Missing test\n3. Type error',
      resultText: 'done',
      needsInput: false,
      sessionId: 'sess-1',
    };

    expect(extractFindings(result)).toBe(result.assistantText);
  });

  it('returns empty string when assistant text is empty', () => {
    const result = {
      exitCode: 0,
      assistantText: '',
      resultText: 'done',
      needsInput: false,
      sessionId: 'sess-1',
    };

    expect(extractFindings(result)).toBe('');
  });
});

const makeScript = async (dir: string, name: string, body: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

describe('extractFormattedFindings', () => {
  it('returns formatted result from quiet-mode agent call', async () => {
    const script = await makeScript(tempDir, 'agent.sh', [
      'printf \'{"type":"result","result":"## Summary\\\\n\\\\n3 issues found.","duration_ms":50,"num_turns":1}\\n\'',
    ].join('\n'));

    const result = await extractFormattedFindings({
      prompt: 'summarize findings',
      command: script,
      args: [],
      sessionId: 'sess-1',
    });

    expect(result).toBe('## Summary\n\n3 issues found.');
  });

  it('returns empty string when quiet-mode call fails', async () => {
    const result = await extractFormattedFindings({
      prompt: 'summarize',
      command: '/nonexistent/agent',
      args: [],
      sessionId: 'sess-1',
    });

    expect(result).toBe('');
  });
});
