import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { createWorktree, removeWorktree, verifyWorktree } from "../src/worktree.js";

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
      expect(result).toEqual({ ok: false, reason: "wrong-branch", detail: expect.stringContaining("other") });
    });
  });
});
