import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

const git = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
};

export const captureRef = async (cwd: string): Promise<string> => {
  return git(["rev-parse", "HEAD"], cwd);
};

export const hasChanges = async (cwd: string, since: string): Promise<boolean> => {
  const currentRef = await captureRef(cwd);
  if (currentRef !== since) return true;

  const status = await git(["status", "--porcelain"], cwd);
  return status.length > 0;
};

export const getStatus = async (cwd: string): Promise<string> => {
  return git(["status", "--short"], cwd);
};

export const hasDirtyTree = async (cwd: string): Promise<boolean> => {
  const status = await git(["status", "--porcelain"], cwd);
  return status.length > 0;
};

export const stashSave = async (cwd: string): Promise<boolean> => {
  const dirty = await hasDirtyTree(cwd);
  if (!dirty) return false;
  await git(["stash", "push", "-u", "-m", "orch: protect working tree"], cwd);
  return true;
};

export const stashPop = async (cwd: string): Promise<void> => {
  try {
    await git(["stash", "pop"], cwd);
  } catch {
    // stash pop can fail if the stash conflicts — leave it in the stash list
  }
};
