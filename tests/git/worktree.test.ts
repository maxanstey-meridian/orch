import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { createWorktree, removeWorktree, verifyWorktree, checkWorktreeResume, runCleanup } from "#infrastructure/git/worktree.js";
import { saveState } from "#infrastructure/state/state.js";

const exec = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "orch-worktree-test-"));
  exec("git init", repoDir);
  exec('git config user.email "test@test.com"', repoDir);
  exec('git config user.name "Test"', repoDir);
  execSync("echo initial > file.txt", { cwd: repoDir });
  exec("git add .", repoDir);
  exec('git commit -m "initial"', repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true });
});

describe("checkWorktreeResume", () => {
  it("errors when no --branch but state has a managed worktree", async () => {
    const state = {
      worktree: { path: "/fake", branch: "orch/x", baseSha: "abc123", managed: true },
    };
    const result = await checkWorktreeResume(undefined, undefined, state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run used --branch"),
    });
    expect((result as { message: string }).message).toContain("orch/x");
  });

  it("errors when --branch but previous run was in-place with progress", async () => {
    const state = { lastCompletedSlice: 3 };
    const result = await checkWorktreeResume("orch/new", undefined, state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run was in-place"),
    });
    expect((result as { message: string }).message).toContain("--reset");
  });

  it("errors when --tree but previous run was in-place with progress", async () => {
    const state = { lastCompletedSlice: 3 };
    const result = await checkWorktreeResume(undefined, join(repoDir, "external-tree"), state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run was in-place"),
    });
    expect((result as { message: string }).message).toContain("--reset");
  });

  it("errors when --branch but previous run was in-place with only lastCompletedGroup progress", async () => {
    const state = { lastCompletedGroup: "Auth" };
    const result = await checkWorktreeResume("orch/new", undefined, state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run was in-place"),
    });
    expect((result as { message: string }).message).toContain("--reset");
  });

  it("returns ok when state worktree exists and is valid", async () => {
    const treePath = await createWorktree(repoDir, "plan-resume", "orch/plan-resume");
    const baseSha = exec("git rev-parse HEAD", treePath);
    const state = {
      worktree: { path: treePath, branch: "orch/plan-resume", baseSha, managed: true },
    };
    const result = await checkWorktreeResume("orch/plan-resume", undefined, state);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when worktree is valid and lastCompletedSlice is 0 (fresh start)", async () => {
    const treePath = await createWorktree(repoDir, "plan-fresh", "orch/plan-fresh");
    const baseSha = exec("git rev-parse HEAD", treePath);
    const state = {
      worktree: { path: treePath, branch: "orch/plan-fresh", baseSha, managed: true },
      lastCompletedSlice: 0,
    };
    const result = await checkWorktreeResume("orch/plan-fresh", undefined, state);
    expect(result).toEqual({ ok: true });
  });

  it("errors when worktree is on wrong branch", async () => {
    const treePath = await createWorktree(repoDir, "plan-br", "orch/plan-br");
    exec("git checkout -b other", treePath);
    const baseSha = exec("git rev-parse HEAD", treePath);
    const state = {
      worktree: { path: treePath, branch: "orch/plan-br", baseSha, managed: true },
    };
    const result = await checkWorktreeResume("orch/plan-br", undefined, state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("is on branch"),
    });
    const msg = (result as { message: string }).message;
    expect(msg).toContain("other");
    expect(msg).toContain("orch/plan-br");
  });

  it("errors when HEAD hasn't advanced but slices are marked complete", async () => {
    const treePath = await createWorktree(repoDir, "plan-stale", "orch/plan-stale");
    const baseSha = exec("git rev-parse HEAD", treePath);
    const state = {
      worktree: { path: treePath, branch: "orch/plan-stale", baseSha, managed: true },
      lastCompletedSlice: 2,
    };
    const result = await checkWorktreeResume("orch/plan-stale", undefined, state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Commits missing"),
    });
  });

  it("errors when managed worktree path is missing", async () => {
    const state = {
      worktree: {
        path: "/tmp/gone-" + Date.now(),
        branch: "orch/x",
        baseSha: "abc",
        managed: true,
      },
    };
    const result = await checkWorktreeResume("orch/x", undefined, state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Worktree missing"),
    });
    expect((result as { message: string }).message).toContain("--reset");
  });

  it("returns ok for an external tree without requiring --branch", async () => {
    const externalTreePath = join(repoDir, "external-tree");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
    };

    const result = await checkWorktreeResume(undefined, undefined, state);

    expect(result).toEqual({ ok: true });
  });

  it("errors when an external tree is resumed from a different --tree path", async () => {
    const externalTreePath = join(repoDir, "external-tree");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
    };

    const result = await checkWorktreeResume(undefined, join(repoDir, "other-tree"), state);

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run used --tree"),
    });
    expect((result as { message: string }).message).toContain(externalTreePath);
  });

  it("errors when an external tree resume switches to --branch mode", async () => {
    const externalTreePath = join(repoDir, "external-branch-mode");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
    };

    const result = await checkWorktreeResume("orch/new", undefined, state);

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run used --tree"),
    });
    expect((result as { message: string }).message).toContain("Omit --branch");
  });

  it("errors when an external tree is on the wrong branch", async () => {
    const externalTreePath = join(repoDir, "external-branch");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    exec("git checkout -b other", externalTreePath);
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
    };

    const result = await checkWorktreeResume(undefined, externalTreePath, state);

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("is on branch"),
    });
    expect((result as { message: string }).message).toContain("other");
    expect((result as { message: string }).message).toContain(branch);
  });

  it("errors when a branchless external resume finds the saved tree on the wrong branch", async () => {
    const externalTreePath = join(repoDir, "external-branchless-wrong-branch");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    exec("git checkout -b other", externalTreePath);
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
    };

    const result = await checkWorktreeResume(undefined, undefined, state);

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("is on branch"),
    });
    expect((result as { message: string }).message).toContain("other");
    expect((result as { message: string }).message).toContain(branch);
  });

  it("errors when an external tree HEAD has not advanced but slices are marked complete", async () => {
    const externalTreePath = join(repoDir, "external-stale");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
      lastCompletedSlice: 2,
    };

    const result = await checkWorktreeResume(undefined, externalTreePath, state);

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Commits missing"),
    });
  });

  it("errors when a branchless external resume has completed slices but HEAD is still at baseSha", async () => {
    const externalTreePath = join(repoDir, "external-branchless-stale");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
      lastCompletedSlice: 2,
    };

    const result = await checkWorktreeResume(undefined, undefined, state);

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Commits missing"),
    });
  });

  it("returns ok with no worktree state and no branch flag", async () => {
    const result = await checkWorktreeResume(undefined, undefined, {});
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for fresh start with --branch and empty state", async () => {
    const result = await checkWorktreeResume("orch/new", undefined, {});
    expect(result).toEqual({ ok: true });
  });
});

describe("runCleanup", () => {
  it("removes managed worktree directory and clears state file when worktree state exists", async () => {
    const treePath = await createWorktree(repoDir, "plan-cleanup", "orch/plan-cleanup");
    const baseSha = exec("git rev-parse HEAD", treePath);
    const stateFile = join(repoDir, ".orch/state/plan-cleanup.json");
    const state = {
      worktree: { path: treePath, branch: "orch/plan-cleanup", baseSha, managed: true },
    };
    await mkdir(join(repoDir, ".orch/state"), { recursive: true });
    await saveState(stateFile, state);

    const message = await runCleanup(stateFile, state, repoDir);

    await expect(stat(treePath)).rejects.toThrow();
    await expect(stat(stateFile)).rejects.toThrow();
    expect(exec("git branch --list orch/plan-cleanup", repoDir)).toContain("orch/plan-cleanup");
    expect(message).toContain("Removed worktree");
  });

  it("clears state file and returns message when no worktree state exists", async () => {
    const stateFile = join(repoDir, ".orch/state/plan-no-wt.json");
    const state = { lastCompletedSlice: 3 };
    await mkdir(join(repoDir, ".orch/state"), { recursive: true });
    await saveState(stateFile, state);

    const message = await runCleanup(stateFile, state, repoDir);

    await expect(stat(stateFile)).rejects.toThrow();
    expect(message).toContain("No worktree to clean up");
  });

  it("tolerates already-removed worktree and still clears state", async () => {
    const treePath = await createWorktree(repoDir, "plan-gone", "orch/plan-gone");
    const baseSha = exec("git rev-parse HEAD", treePath);
    const stateFile = join(repoDir, ".orch/state/plan-gone.json");
    const state = {
      worktree: { path: treePath, branch: "orch/plan-gone", baseSha, managed: true },
    };
    await mkdir(join(repoDir, ".orch/state"), { recursive: true });
    await saveState(stateFile, state);
    // Manually remove the worktree before cleanup
    await removeWorktree(treePath, repoDir);

    const message = await runCleanup(stateFile, state, repoDir);

    await expect(stat(stateFile)).rejects.toThrow();
    expect(message).toContain("No worktree to clean up");
    expect(message).toContain("State cleared");
  });

  it("does not remove worktree when state has been cleared before cleanup (--reset --cleanup interaction)", async () => {
    const treePath = await createWorktree(repoDir, "plan-reset-cleanup", "orch/plan-reset-cleanup");
    // State was cleared by --reset, so runCleanup sees empty state
    const stateFile = join(repoDir, ".orch/state/plan-reset-cleanup.json");
    const message = await runCleanup(stateFile, {}, repoDir);

    // Worktree still exists — runCleanup didn't know about it
    const s = await stat(treePath);
    expect(s.isDirectory()).toBe(true);
    expect(message).toContain("No worktree to clean up");
  });

  it("preserves external trees and only clears Orch state", async () => {
    const externalTreePath = join(repoDir, "external-cleanup");
    exec(`git worktree add ${externalTreePath}`, repoDir);
    const baseSha = exec("git rev-parse HEAD", externalTreePath);
    const branch = exec("git branch --show-current", externalTreePath);
    const stateFile = join(repoDir, ".orch/state/plan-external-cleanup.json");
    const state = {
      worktree: { path: externalTreePath, branch, baseSha, managed: false },
    };
    await mkdir(join(repoDir, ".orch/state"), { recursive: true });
    await saveState(stateFile, state);

    const message = await runCleanup(stateFile, state, repoDir);

    const externalTreeStats = await stat(externalTreePath);
    expect(externalTreeStats.isDirectory()).toBe(true);
    await expect(stat(stateFile)).rejects.toThrow();
    expect(message).toContain("Preserved external tree");
    expect(message).toContain(externalTreePath);
  });

  it("succeeds when state file does not exist", async () => {
    const stateFile = "/tmp/nonexistent-state-" + Date.now() + ".json";
    const message = await runCleanup(stateFile, {}, repoDir);
    expect(message).toContain("No worktree to clean up");
  });
});

describe("worktree", () => {
  it("creates a worktree directory and checks out a new branch", async () => {
    const path = await createWorktree(repoDir, "plan-1", "orch/plan-1");

    expect(path).toBe(join(repoDir, ".orch/trees/plan-1"));
    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
    expect(exec("git branch --show-current", path)).toBe("orch/plan-1");
  });

  it("checks out an existing branch into a new worktree", async () => {
    exec("git branch orch/plan-2", repoDir);
    const path = await createWorktree(repoDir, "plan-2", "orch/plan-2");

    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
    expect(exec("git branch --show-current", path)).toBe("orch/plan-2");
  });

  it("propagates non-branch errors instead of swallowing them", async () => {
    // Occupy the path with an existing worktree — a second createWorktree at
    // the same path should fail with a path-already-exists error, not silently
    // retry the branch fallback.
    await createWorktree(repoDir, "plan-conflict", "orch/plan-conflict");
    await expect(createWorktree(repoDir, "plan-conflict", "orch/other")).rejects.toThrow(/already exists/);
  });

  it("removeWorktree throws when path does not exist", async () => {
    await expect(removeWorktree("/tmp/nonexistent-" + Date.now(), repoDir)).rejects.toThrow();
  });

  it("removeWorktree removes the worktree directory", async () => {
    const path = await createWorktree(repoDir, "plan-rm", "orch/plan-rm");
    await removeWorktree(path, repoDir);

    await expect(stat(path)).rejects.toThrow();
    const list = exec("git worktree list", repoDir);
    expect(list).not.toContain(path);
  });

  describe("verifyWorktree", () => {
    it("returns missing when path does not exist", async () => {
      const result = await verifyWorktree("/tmp/does-not-exist-" + Date.now(), "any-branch");
      expect(result).toEqual({ ok: false, reason: "missing", detail: expect.stringContaining("does not exist") });
    });

    it("returns ok when worktree exists on expected branch", async () => {
      const path = await createWorktree(repoDir, "verify-ok", "orch/verify-ok");
      const result = await verifyWorktree(path, "orch/verify-ok");
      expect(result).toEqual({ ok: true });
    });

    it("returns missing when path is a plain directory, not a git worktree", async () => {
      const plainDir = join(repoDir, "not-a-worktree");
      await mkdir(plainDir);
      const result = await verifyWorktree(plainDir, "any-branch");
      expect(result).toEqual({ ok: false, reason: "missing", detail: expect.stringContaining("not a git worktree") });
    });

    it("returns missing when path is a file, not a directory", async () => {
      const filePath = join(repoDir, "file.txt");
      const result = await verifyWorktree(filePath, "any-branch");
      expect(result).toEqual({ ok: false, reason: "missing", detail: expect.stringContaining("not a git worktree") });
    });

    it("returns wrong-branch when worktree is on a different branch", async () => {
      const path = await createWorktree(repoDir, "verify-br", "orch/verify-br");
      exec("git checkout -b other", path);
      const result = await verifyWorktree(path, "orch/verify-br");
      expect(result).toEqual({ ok: false, reason: "wrong-branch", detail: expect.stringContaining("other"), actual: "other" });
    });
  });
});
