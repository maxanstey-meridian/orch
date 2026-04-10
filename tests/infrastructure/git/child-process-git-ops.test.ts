import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildProcessGitOps } from "#infrastructure/git/child-process-git-ops.js";

const exec = (command: string, cwd: string): string =>
  execSync(command, { cwd, encoding: "utf-8" }).trim();

describe("ChildProcessGitOps", () => {
  let repoDir = "";
  let gitOps: ChildProcessGitOps;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "orch-child-git-"));
    exec("git init", repoDir);
    exec('git config user.email "test@test.com"', repoDir);
    exec('git config user.name "Test"', repoDir);
    await writeFile(join(repoDir, "file.txt"), "initial\n");
    exec("git add .", repoDir);
    exec('git commit -m "initial"', repoDir);
    gitOps = new ChildProcessGitOps(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("captures the current HEAD reference", async () => {
    const actual = await gitOps.captureRef();

    expect(actual).toBe(exec("git rev-parse HEAD", repoDir));
    expect(actual).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports changes when the working tree has been modified", async () => {
    const base = await gitOps.captureRef();
    await writeFile(join(repoDir, "file.txt"), "modified\n");

    await expect(gitOps.hasChanges(base)).resolves.toBe(true);
  });

  it("reports a clean tree when nothing changed since the base ref", async () => {
    const base = await gitOps.captureRef();

    await expect(gitOps.hasChanges(base)).resolves.toBe(false);
  });

  it("detects dirty tree state and reports status output", async () => {
    await writeFile(join(repoDir, "untracked.txt"), "new file\n");

    await expect(gitOps.hasDirtyTree()).resolves.toBe(true);
    await expect(gitOps.getStatus()).resolves.toContain("untracked.txt");
  });

  it("returns the committed diff since the base ref and ignores later working tree edits", async () => {
    const base = await gitOps.captureRef();
    await writeFile(join(repoDir, "file.txt"), "committed change\n");
    exec("git add file.txt", repoDir);
    exec('git commit -m "second"', repoDir);
    await writeFile(join(repoDir, "file.txt"), "working tree only\n");

    const diff = await gitOps.getDiff(base);

    expect(diff).toContain("committed change");
    expect(diff).not.toContain("working tree only");
  });

  it("creates and reapplies a stash backup for a dirty tree", async () => {
    await writeFile(join(repoDir, "dirty.txt"), "dirty\n");

    await expect(gitOps.stashBackup()).resolves.toBe(true);
    await expect(gitOps.hasDirtyTree()).resolves.toBe(true);
    expect(exec("git stash list", repoDir)).toContain("orch: protect working tree");
  });

  it("returns false from stashBackup when the tree is already clean", async () => {
    await expect(gitOps.stashBackup()).resolves.toBe(false);
  });

  it("measures added and removed lines using the review-threshold diff logic", async () => {
    const base = await gitOps.captureRef();
    await writeFile(join(repoDir, "file.txt"), "line1\nline2\nline3\n");
    await writeFile(join(repoDir, "extra.txt"), "x\ny\n");
    exec("git add extra.txt", repoDir);

    await expect(gitOps.measureDiff(base)).resolves.toEqual({
      added: 5,
      removed: 1,
      total: 6,
    });
  });
});
