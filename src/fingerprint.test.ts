import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runFingerprint, wrapBrief } from './fingerprint.js';

const makeScript = async (dir: string, name: string, body: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-fp-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('runFingerprint', () => {
  it('returns defaults when fingerprint process is not found', async () => {
    const result = await runFingerprint({
      cwd: tempDir,
      processPath: '/nonexistent/fingerprint.sh',
      outputDir: tempDir,
    });
    expect(result.brief).toBe('');
    expect(result.profile).toEqual({});
  });

  it('returns defaults when fingerprint process fails', async () => {
    const briefPath = join(tempDir, 'brief.md');
    const script = await makeScript(tempDir, 'fail.sh', [
      `echo "# Should not load" > "${briefPath}"`,
      'exit 1',
    ].join('\n'));
    const result = await runFingerprint({
      cwd: tempDir,
      processPath: script,
      outputDir: tempDir,
    });
    expect(result.brief).toBe('');
    expect(result.profile).toEqual({});
  });

  it('returns defaults when output files are missing after successful run', async () => {
    const script = await makeScript(tempDir, 'noop.sh', 'exit 0');
    const result = await runFingerprint({
      cwd: tempDir,
      processPath: script,
      outputDir: tempDir,
    });
    expect(result.brief).toBe('');
    expect(result.profile).toEqual({});
  });

  it('skips fingerprinting when skip flag is set', async () => {
    const briefPath = join(tempDir, 'brief.md');
    const profilePath = join(tempDir, 'profile.json');
    const script = await makeScript(tempDir, 'skip.sh', [
      `echo "# Brief" > "${briefPath}"`,
      `echo '{"stack":"ts"}' > "${profilePath}"`,
    ].join('\n'));
    const result = await runFingerprint({
      cwd: tempDir,
      processPath: script,
      outputDir: tempDir,
      skip: true,
    });
    expect(result.brief).toBe('');
    expect(result.profile).toEqual({});
  });

  it('loads profile and brief after successful fingerprint', async () => {
    const briefPath = join(tempDir, 'brief.md');
    const profilePath = join(tempDir, 'profile.json');
    const script = await makeScript(tempDir, 'fp.sh', [
      `echo "# Codebase Brief" > "${briefPath}"`,
      `echo '{"stack":"typescript","testCommand":"vitest run"}' > "${profilePath}"`,
    ].join('\n'));

    const result = await runFingerprint({
      cwd: tempDir,
      processPath: script,
      outputDir: tempDir,
    });
    expect(result.brief).toBe('# Codebase Brief');
    expect(result.profile).toEqual({ stack: 'typescript', testCommand: 'vitest run' });
  });
});

describe('wrapBrief', () => {
  it('returns empty string for empty brief', () => {
    expect(wrapBrief('')).toBe('');
  });

  it('wraps non-empty brief in codebase-brief tags', () => {
    const brief = '# Codebase Brief\n\nTypeScript project.';
    const wrapped = wrapBrief(brief);
    expect(wrapped).toContain('<codebase-brief>');
    expect(wrapped).toContain('</codebase-brief>');
    expect(wrapped).toContain(brief);
  });
});
