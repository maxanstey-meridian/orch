import { GitOps } from "../application/ports/git-ops.port.js";
import { captureRef, hasChanges, hasDirtyTree, getStatus, getDiff, stashBackup } from "./git/git.js";
import { measureDiff } from "./cli/review-threshold.js";

export class ChildProcessGitOps extends GitOps {
  constructor(private readonly cwd: string) {
    super();
  }

  captureRef() {
    return captureRef(this.cwd);
  }

  hasChanges(since: string) {
    return hasChanges(this.cwd, since);
  }

  hasDirtyTree() {
    return hasDirtyTree(this.cwd);
  }

  getStatus() {
    return getStatus(this.cwd);
  }

  getDiff(since: string) {
    return getDiff(this.cwd, since);
  }

  stashBackup() {
    return stashBackup(this.cwd);
  }

  async measureDiff(since: string) {
    const stats = await measureDiff(this.cwd, since);
    return { added: stats.linesAdded, removed: stats.linesRemoved, total: stats.total };
  }
}
