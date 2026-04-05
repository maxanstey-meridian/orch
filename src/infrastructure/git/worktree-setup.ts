import { execFile } from "child_process";
import type { ExecFileException } from "child_process";
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
  readonly worktreeSetup: readonly string[];
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

const runShellCommand = async (
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.SHELL ?? "/bin/sh",
      ["-lc", command],
      { cwd, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error) {
          const execError = error as ExecFileException & { stdout?: string; stderr?: string };
          execError.stdout = stdout;
          execError.stderr = stderr;
          reject(execError);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });

const formatSetupOutput = (stdout?: string, stderr?: string): string =>
  [stdout?.trim(), stderr?.trim()].filter((part) => part && part.length > 0).join("\n");

const runWorktreeSetupCommands = async (
  commands: readonly string[],
  cwd: string,
): Promise<void> => {
  for (const command of commands) {
    try {
      await runShellCommand(command, cwd);
    } catch (error) {
      const execError = error as ExecFileException & { stdout?: string; stderr?: string };
      const output = formatSetupOutput(execError.stdout, execError.stderr);
      throw new Error(
        output.length > 0
          ? `Worktree setup command failed: ${command}\n${output}`
          : `Worktree setup command failed: ${command}`,
      );
    }
  }
};

export const resolveWorktree = async (opts: ResolveWorktreeOpts): Promise<WorktreeResult> => {
  const { branchName, cwd, treePath, worktreeSetup, activePlanId, state, stateFile, log } = opts;

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
    await runWorktreeSetupCommands(worktreeSetup, treePath);
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
