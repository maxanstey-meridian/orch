import { execFile } from "child_process";
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

export const createWorktree = async (
  repoRoot: string,
  planId: string,
  branch: string,
): Promise<string> => {
  const treePath = resolve(repoRoot, ".orch/trees", planId);
  try {
    await git(["worktree", "add", treePath, "-b", branch], repoRoot);
  } catch {
    await git(["worktree", "add", treePath, branch], repoRoot);
  }
  return treePath;
};
