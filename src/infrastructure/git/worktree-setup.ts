import type { LogFn } from "#ui/display.js";
import { loadState, saveState, type OrchestratorState } from "../state/state.js";
import { captureCurrentBranch, captureRef } from "./git.js";
import { createWorktree } from "./worktree.js";

type WorktreeResult = {
  readonly cwd: string;
  readonly worktreeInfo?: { readonly path: string; readonly branch: string };
  readonly skipStash: boolean;
  readonly updatedState: OrchestratorState;
};

type ResolveWorktreeOpts = {
  readonly branchName: string | undefined;
  readonly cwd: string;
  readonly treePath: string | undefined;
  readonly activePlanId: string;
  readonly state: OrchestratorState;
  readonly stateFile: string;
  readonly log: LogFn;
};

const mergePersistedState = async (
  stateFile: string,
  fallbackState: OrchestratorState,
): Promise<OrchestratorState> => {
  const persistedState = await loadState(stateFile);
  return Object.keys(persistedState).length === 0 ? fallbackState : persistedState;
};

export const resolveWorktree = async (opts: ResolveWorktreeOpts): Promise<WorktreeResult> => {
  const { branchName, cwd, treePath, activePlanId, state, stateFile, log } = opts;

  // checkWorktreeResume already verified the worktree exists and is on the right branch
  if (state.worktree) {
    return {
      cwd: state.worktree.path,
      worktreeInfo: { path: state.worktree.path, branch: state.worktree.branch },
      skipStash: true,
      updatedState: state,
    };
  }

  if (treePath) {
    const [branch, baseSha, persistedState] = await Promise.all([
      captureCurrentBranch(treePath),
      captureRef(treePath),
      mergePersistedState(stateFile, state),
    ]);
    const worktree = { path: treePath, branch, baseSha, managed: false };
    const updatedState: OrchestratorState = { ...persistedState, worktree };
    await saveState(stateFile, updatedState);
    log(`Using external tree at ${treePath} on branch ${branch}`);
    return {
      cwd: treePath,
      worktreeInfo: { path: treePath, branch },
      skipStash: true,
      updatedState,
    };
  }

  if (branchName) {
    const [baseSha, persistedState] = await Promise.all([
      captureRef(cwd),
      mergePersistedState(stateFile, state),
    ]);
    const treePath = await createWorktree(cwd, activePlanId, branchName);
    const worktree = { path: treePath, branch: branchName, baseSha, managed: true };
    const updatedState: OrchestratorState = { ...persistedState, worktree };
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
