import { createWorktree, verifyWorktree } from "./worktree.js";
import { captureRef } from "./git.js";
import { saveState, type OrchestratorState } from "./state.js";
import type { LogFn } from "./display.js";

type WorktreeResult = {
  readonly cwd: string;
  readonly worktreeInfo?: { readonly path: string; readonly branch: string };
  readonly skipStash: boolean;
  readonly updatedState: OrchestratorState;
};

type ResolveWorktreeOpts = {
  readonly branchName: string | undefined;
  readonly cwd: string;
  readonly activePlanId: string;
  readonly state: OrchestratorState;
  readonly stateFile: string;
  readonly log: LogFn;
};

export const resolveWorktree = async (opts: ResolveWorktreeOpts): Promise<WorktreeResult> => {
  const { branchName, cwd, activePlanId, state, stateFile, log } = opts;

  if (state.worktree) {
    const status = await verifyWorktree(state.worktree.path, state.worktree.branch);
    if (!status.ok) {
      throw new Error(`Worktree verification failed (${status.reason}): ${status.detail}`);
    }
    return {
      cwd: state.worktree.path,
      worktreeInfo: { path: state.worktree.path, branch: state.worktree.branch },
      skipStash: true,
      updatedState: state,
    };
  }

  if (branchName) {
    const baseSha = await captureRef(cwd);
    const treePath = await createWorktree(cwd, activePlanId, branchName);
    const worktree = { path: treePath, branch: branchName, baseSha };
    const updatedState: OrchestratorState = { ...state, worktree };
    await saveState(stateFile, updatedState);
    log(`Worktree created at ${treePath} on branch ${branchName}`);
    return {
      cwd: treePath,
      worktreeInfo: { path: treePath, branch: branchName },
      skipStash: true,
      updatedState,
    };
  }

  return { cwd, skipStash: false, updatedState: state };
};
