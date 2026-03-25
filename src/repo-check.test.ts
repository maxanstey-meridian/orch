import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { assertGitRepo } from './repo-check.js';

const exec = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf-8' }).trim();

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-repo-check-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('assertGitRepo', () => {
  it('throws "Not a git repository" in a dir with no .git', async () => {
    await expect(assertGitRepo(tempDir)).rejects.toThrow('Not a git repository');
    await expect(assertGitRepo(tempDir)).rejects.toThrow('git init');
  });

  it('throws "no commits" in a git init dir with no commits', async () => {
    exec('git init', tempDir);
    await expect(assertGitRepo(tempDir)).rejects.toThrow('no commits');
    await expect(assertGitRepo(tempDir)).rejects.toThrow('git commit --allow-empty');
  });

  it('resolves in a repo with at least one commit', async () => {
    exec('git init', tempDir);
    exec('git config user.email "test@test.com"', tempDir);
    exec('git config user.name "Test"', tempDir);
    await writeFile(join(tempDir, 'file.txt'), 'initial');
    exec('git add .', tempDir);
    exec('git commit -m "initial"', tempDir);

    await expect(assertGitRepo(tempDir)).resolves.toBeUndefined();
  });
});
