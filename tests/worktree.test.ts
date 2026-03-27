import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { createWorktree, removeWorktree, verifyWorktree, checkWorktreeResume } from "../src/worktree.js";

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
  it("errors when no --branch but state has worktree", async () => {
    const state = { worktree: { path: "/fake", branch: "orch/x", baseSha: "abc123" } };
    const result = await checkWorktreeResume(undefined, state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run used --branch"),
    });
    expect((result as { message: string }).message).toContain("orch/x");
  });

  it("errors when --branch but previous run was in-place with progress", async () => {
    const state = { lastCompletedSlice: 3 };
    const result = await checkWorktreeResume("orch/new", state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Previous run was in-place"),
    });
    expect((result as { message: string }).message).toContain("--reset");
  });

  it("returns ok when state worktree exists and is valid", async () => {
    const treePath = await createWorktree(repoDir, "plan-resume", "orch/plan-resume");
    const baseSha = exec("git rev-parse HEAD", treePath);
    const state = { worktree: { path: treePath, branch: "orch/plan-resume", baseSha } };
    const result = await checkWorktreeResume("orch/plan-resume", state);
    expect(result).toEqual({ ok: true });
  });

  it("errors when worktree is on wrong branch", async () => {
    const treePath = await createWorktree(repoDir, "plan-br", "orch/plan-br");
    exec("git checkout -b other", treePath);
    const baseSha = exec("git rev-parse HEAD", treePath);
    const state = { worktree: { path: treePath, branch: "orch/plan-br", baseSha } };
    const result = await checkWorktreeResume("orch/plan-br", state);
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
      worktree: { path: treePath, branch: "orch/plan-stale", baseSha },
      lastCompletedSlice: 2,
    };
    const result = await checkWorktreeResume("orch/plan-stale", state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Commits missing"),
    });
  });

  it("errors when state worktree path is missing", async () => {
    const state = { worktree: { path: "/tmp/gone-" + Date.now(), branch: "orch/x", baseSha: "abc" } };
    const result = await checkWorktreeResume("orch/x", state);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Worktree missing"),
    });
    expect((result as { message: string }).message).toContain("--reset");
  });

  it("returns ok with repo root when no worktree state and no branch flag", async () => {
    const result = await checkWorktreeResume(undefined, {});
    expect(result).toEqual({ ok: true });
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
    await expect(removeWorktree("/tmp/nonexistent-" + Date.now())).rejects.toThrow();
  });

  it("removeWorktree removes the worktree directory", async () => {
    const path = await createWorktree(repoDir, "plan-rm", "orch/plan-rm");
    await removeWorktree(path);

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
