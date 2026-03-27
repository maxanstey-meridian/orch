import { execFile } from "child_process";
import { stat, access } from "fs/promises";
import { promisify } from "util";
import { resolve } from "path";

const run = promisify(execFile);

const git = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
};

export const removeWorktree = async (worktreePath: string): Promise<void> => {
  const cwd = resolve(worktreePath, "..");
  await git(["worktree", "remove", worktreePath], cwd);
};

export type WorktreeStatus =
  | { ok: true }
  | { ok: false; reason: "missing" | "wrong-branch"; detail: string };

export const verifyWorktree = async (
  worktreePath: string,
  expectedBranch: string,
): Promise<WorktreeStatus> => {
  try {
    await stat(worktreePath);
  } catch {
    return { ok: false, reason: "missing", detail: `${worktreePath} does not exist` };
  }
  try {
    await access(resolve(worktreePath, ".git"));
  } catch {
    return { ok: false, reason: "missing", detail: `${worktreePath} is not a git worktree` };
  }
  let actual: string;
  try {
    actual = await git(["branch", "--show-current"], worktreePath);
  } catch {
    return { ok: false, reason: "missing", detail: `${worktreePath} is not a git worktree` };
  }
  if (actual !== expectedBranch) {
    return { ok: false, reason: "wrong-branch", detail: `expected "${expectedBranch}", got "${actual}"` };
  }
  return { ok: true };
};

export const createWorktree = async (
  repoRoot: string,
  planId: string,
  branch: string,
): Promise<string> => {
  const treePath = resolve(repoRoot, ".orch/trees", planId);
  try {
    await git(["worktree", "add", treePath, "-b", branch], repoRoot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("a branch named")) throw err;
    await git(["worktree", "add", treePath, branch], repoRoot);
  }
  return treePath;
};
