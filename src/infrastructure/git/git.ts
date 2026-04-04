import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

export const git = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
};

const resolveHeadRef = async (cwd: string): Promise<string> => git(["rev-parse", "HEAD"], cwd);

export const captureRef = async (cwd: string): Promise<string> => resolveHeadRef(cwd);

export const captureCurrentBranch = async (cwd: string): Promise<string> => {
  const branch = await git(["branch", "--show-current"], cwd);
  if (branch.length === 0) {
    throw new Error(`Cannot determine current branch for ${cwd}. Detached HEAD is not supported.`);
  }

  return branch;
};

export const hasChanges = async (cwd: string, since: string): Promise<boolean> => {
  const head = await resolveHeadRef(cwd);
  if (head !== since) {
    return true;
  }

  return hasDirtyTree(cwd);
};

export const getStatus = async (cwd: string): Promise<string> => {
  return git(["status", "--short"], cwd);
};

export const getDiff = async (cwd: string, since: string): Promise<string> => {
  const head = await resolveHeadRef(cwd);
  return head === since ? git(["diff", since], cwd) : git(["diff", `${since}..HEAD`], cwd);
};

export const hasDirtyTree = async (cwd: string): Promise<boolean> => {
  const status = await git(["status", "--porcelain"], cwd);
  return status.length > 0;
};

export const stashBackup = async (cwd: string): Promise<boolean> => {
  const dirty = await hasDirtyTree(cwd);
  if (!dirty) {
    return false;
  }
  await git(["stash", "push", "-u", "-m", "orch: protect working tree"], cwd);
  await git(["stash", "apply"], cwd);
  return true;
};
