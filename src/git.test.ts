import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { captureRef, hasChanges, getStatus } from './git.js';

const exec = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf-8' }).trim();

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'orch-git-test-'));
  exec('git init', repoDir);
  exec('git config user.email "test@test.com"', repoDir);
  exec('git config user.name "Test"', repoDir);
  await writeFile(join(repoDir, 'file.txt'), 'initial');
  exec('git add .', repoDir);
  exec('git commit -m "initial"', repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true });
});

describe('git', () => {
  it('captures the current commit reference', async () => {
    const ref = await captureRef(repoDir);
    const expected = exec('git rev-parse HEAD', repoDir);
    expect(ref).toBe(expected);
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports no changes when repo is clean at same ref', async () => {
    const ref = await captureRef(repoDir);
    expect(await hasChanges(repoDir, ref)).toBe(false);
  });

  it('detects new commits since reference', async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, 'new.txt'), 'new content');
    exec('git add .', repoDir);
    exec('git commit -m "second"', repoDir);
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it('detects uncommitted modifications at same commit', async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, 'file.txt'), 'modified');
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it('detects untracked files as changes at same commit', async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, 'untracked.txt'), 'new file');
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it('detects changes when both a new commit and uncommitted modifications exist', async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, 'new.txt'), 'committed content');
    exec('git add .', repoDir);
    exec('git commit -m "second"', repoDir);
    await writeFile(join(repoDir, 'new.txt'), 'uncommitted modification');
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it('returns non-empty status showing staged files', async () => {
    await writeFile(join(repoDir, 'staged.txt'), 'staged content');
    exec('git add staged.txt', repoDir);
    const status = await getStatus(repoDir);
    expect(status).toContain('staged.txt');
    expect(status.length).toBeGreaterThan(0);
  });

  it('returns empty status for a clean working tree', async () => {
    const status = await getStatus(repoDir);
    expect(status).toBe('');
  });

  it('returns human-readable working tree status', async () => {
    await writeFile(join(repoDir, 'file.txt'), 'modified');
    await writeFile(join(repoDir, 'untracked.txt'), 'new');
    const status = await getStatus(repoDir);
    expect(status).toContain('file.txt');
    expect(status).toContain('untracked.txt');
    expect(status.length).toBeGreaterThan(0);
  });
});
