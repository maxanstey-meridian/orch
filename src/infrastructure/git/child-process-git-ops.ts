import { GitOps } from "#application/ports/git-ops.port.js";
import { measureDiff as measureReviewDiff } from "#infrastructure/cli/review-threshold.js";
import {
  captureRef as captureGitRef,
  getDiff as getGitDiff,
  getStatus as getGitStatus,
  hasChanges as gitHasChanges,
  hasDirtyTree as gitHasDirtyTree,
  stashBackup as gitStashBackup,
} from "./git.js";

export class ChildProcessGitOps extends GitOps {
  constructor(private readonly cwd: string) {
    super();
  }

  async captureRef(): Promise<string> {
    return captureGitRef(this.cwd);
  }

  async hasChanges(since: string): Promise<boolean> {
    return gitHasChanges(this.cwd, since);
  }

  async hasDirtyTree(): Promise<boolean> {
    return gitHasDirtyTree(this.cwd);
  }

  async getStatus(): Promise<string> {
    return getGitStatus(this.cwd);
  }

  async getDiff(since: string): Promise<string> {
    return getGitDiff(this.cwd, since);
  }

  async stashBackup(): Promise<boolean> {
    return gitStashBackup(this.cwd);
  }

  async measureDiff(since: string): Promise<{ added: number; removed: number; total: number }> {
    const stats = await measureReviewDiff(this.cwd, since);
    return {
      added: stats.linesAdded,
      removed: stats.linesRemoved,
      total: stats.total,
    };
  }
}
