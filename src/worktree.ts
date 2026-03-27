import { execFile } from "child_process";
import { stat, access } from "fs/promises";
import { promisify } from "util";
import { resolve } from "path";
import { captureRef } from "./git.js";
import { type OrchestratorState } from "./state.js";

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
  | { ok: false; reason: "missing"; detail: string }
  | { ok: false; reason: "wrong-branch"; detail: string; actual: string };

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
    return { ok: false, reason: "wrong-branch", detail: `expected "${expectedBranch}", got "${actual}"`, actual };
  }
  return { ok: true };
};

export type ResumeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export const checkWorktreeResume = async (
  branchFlag: string | undefined,
  state: OrchestratorState,
): Promise<ResumeCheck> => {
  if (!branchFlag && state.worktree) {
    return { ok: false, message: `Previous run used --branch ${state.worktree.branch}. Pass --branch again to resume, or --reset to start fresh.` };
  }
  if (branchFlag && !state.worktree && (state.lastCompletedSlice != null || state.lastCompletedGroup != null)) {
    return { ok: false, message: `Previous run was in-place (no --branch). Use --reset to start fresh before switching to worktree mode.` };
  }
  if (branchFlag && state.worktree) {
    const status = await verifyWorktree(state.worktree.path, state.worktree.branch);
    if (status.ok) {
      if (state.lastCompletedSlice != null && state.lastCompletedSlice > 0) {
        const currentHead = await captureRef(state.worktree.path);
        if (currentHead === state.worktree.baseSha) {
          return { ok: false, message: `Commits missing: HEAD is still at baseSha (${state.worktree.baseSha.slice(0, 8)}) but ${state.lastCompletedSlice} slice(s) are marked complete. Worktree may have been reset.` };
        }
      }
      return { ok: true };
    }
    if (status.reason === "missing") {
      return { ok: false, message: `Worktree missing at ${state.worktree.path}. Use --reset to start fresh.` };
    }
    if (status.reason === "wrong-branch") {
      return { ok: false, message: `Worktree at ${state.worktree.path} is on branch ${status.actual}, expected ${state.worktree.branch}.` };
    }
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
