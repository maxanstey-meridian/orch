import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  captureRef,
  hasChanges,
  getDiff,
  getStatus,
  hasDirtyTree,
} from "../../src/infrastructure/git/git.js";

const exec = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "orch-git-test-"));
  exec("git init", repoDir);
  exec('git config user.email "test@test.com"', repoDir);
  exec('git config user.name "Test"', repoDir);
  await writeFile(join(repoDir, "file.txt"), "initial");
  exec("git add .", repoDir);
  exec('git commit -m "initial"', repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true });
});

describe("git", () => {
  it("captures the current commit reference", async () => {
    const ref = await captureRef(repoDir);
    const expected = exec("git rev-parse HEAD", repoDir);
    expect(ref).toBe(expected);
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports no changes when repo is clean at same ref", async () => {
    const ref = await captureRef(repoDir);
    expect(await hasChanges(repoDir, ref)).toBe(false);
  });

  it("detects new commits since reference", async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, "new.txt"), "new content");
    exec("git add .", repoDir);
    exec('git commit -m "second"', repoDir);
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it("detects uncommitted modifications at same commit", async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, "file.txt"), "modified");
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it("detects untracked files as changes at same commit", async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, "untracked.txt"), "new file");
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it("detects changes when both a new commit and uncommitted modifications exist", async () => {
    const ref = await captureRef(repoDir);
    await writeFile(join(repoDir, "new.txt"), "committed content");
    exec("git add .", repoDir);
    exec('git commit -m "second"', repoDir);
    await writeFile(join(repoDir, "new.txt"), "uncommitted modification");
    expect(await hasChanges(repoDir, ref)).toBe(true);
  });

  it("returns non-empty status showing staged files", async () => {
    await writeFile(join(repoDir, "staged.txt"), "staged content");
    exec("git add staged.txt", repoDir);
    const status = await getStatus(repoDir);
    expect(status).toContain("staged.txt");
    expect(status.length).toBeGreaterThan(0);
  });

  it("returns empty status for a clean working tree", async () => {
    const status = await getStatus(repoDir);
    expect(status).toBe("");
  });

  it("returns human-readable working tree status", async () => {
    await writeFile(join(repoDir, "file.txt"), "modified");
    await writeFile(join(repoDir, "untracked.txt"), "new");
    const status = await getStatus(repoDir);
    expect(status).toContain("file.txt");
    expect(status).toContain("untracked.txt");
    expect(status.length).toBeGreaterThan(0);
  });

  describe("getDiff", () => {
    it("returns diff text between two commits", async () => {
      const refBefore = await captureRef(repoDir);
      await writeFile(join(repoDir, "file.txt"), "modified");
      exec("git add file.txt", repoDir);
      exec('git commit -m "second"', repoDir);

      const diff = await getDiff(repoDir, refBefore);
      const expected = exec(`git diff ${refBefore}..HEAD`, repoDir);

      expect(diff).toBe(expected);
      expect(diff).toContain("file.txt");
    });

    it("returns empty string when since equals HEAD", async () => {
      const ref = await captureRef(repoDir);
      expect(await getDiff(repoDir, ref)).toBe("");
    });
  });

  describe("hasDirtyTree", () => {
    it("returns false on a clean repo", async () => {
      expect(await hasDirtyTree(repoDir)).toBe(false);
    });

    it("returns true after creating an untracked file", async () => {
      await writeFile(join(repoDir, "untracked.txt"), "new file");
      expect(await hasDirtyTree(repoDir)).toBe(true);
    });

    it("returns true after staging a change", async () => {
      await writeFile(join(repoDir, "file.txt"), "modified");
      exec("git add file.txt", repoDir);
      expect(await hasDirtyTree(repoDir)).toBe(true);
    });

    it("returns false after committing — only checks working tree, not HEAD movement", async () => {
      const refBefore = await captureRef(repoDir);
      await writeFile(join(repoDir, "new.txt"), "content");
      exec("git add .", repoDir);
      exec('git commit -m "second"', repoDir);
      // hasDirtyTree should be false — tree is clean
      expect(await hasDirtyTree(repoDir)).toBe(false);
      // hasChanges should be true — HEAD moved
      expect(await hasChanges(repoDir, refBefore)).toBe(true);
    });
  });
});
