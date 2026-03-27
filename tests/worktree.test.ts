import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { createWorktree, removeWorktree } from "../src/worktree.js";

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

  it("removeWorktree removes the worktree directory", async () => {
    const path = await createWorktree(repoDir, "plan-rm", "orch/plan-rm");
    await removeWorktree(path);

    await expect(stat(path)).rejects.toThrow();
    const list = exec("git worktree list", repoDir);
    expect(list).not.toContain(path);
  });
});
