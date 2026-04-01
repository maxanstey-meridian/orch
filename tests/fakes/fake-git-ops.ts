import { GitOps } from "#application/ports/git-ops.port.js";

export class InMemoryGitOps extends GitOps {
  private sha = 0;
  private changesExist = false;
  private dirty = false;
  private diffStats = { added: 0, removed: 0, total: 0 };

  /** Per-call overrides for hasChanges. Consumed FIFO. When empty, falls back to changesExist. */
  private hasChangesQueue: boolean[] = [];

  /** Hook called on captureRef — use to trigger side effects at specific execution points. */
  onCaptureRef: (() => void) | null = null;
  /** Hook called on hasChanges — use to trigger side effects at specific execution points. */
  onHasChanges: (() => void) | null = null;

  // ── Test configuration ──

  setHasChanges(v: boolean): void {
    this.changesExist = v;
  }

  /** Queue specific hasChanges responses (consumed FIFO, then falls back to default). */
  queueHasChanges(...values: boolean[]): void {
    this.hasChangesQueue.push(...values);
  }

  setDirty(v: boolean): void {
    this.dirty = v;
  }

  setDiffStats(stats: { added: number; removed: number; total: number }): void {
    this.diffStats = { ...stats };
  }

  /** Simulate a commit: advances the SHA counter. */
  advanceSha(): void {
    this.sha++;
  }

  // ── GitOps implementation ──

  async captureRef(): Promise<string> {
    this.onCaptureRef?.();
    return `sha-${this.sha}`;
  }

  async hasChanges(since: string): Promise<boolean> {
    this.onHasChanges?.();
    if (this.hasChangesQueue.length > 0) {
      return this.hasChangesQueue.shift()!;
    };
    return this.changesExist;
  }

  async hasDirtyTree(): Promise<boolean> {
    return this.dirty;
  }

  async getStatus(): Promise<string> {
    return "";
  }

  async getDiff(_since: string): Promise<string> {
    return "";
  }

  async stashBackup(): Promise<boolean> {
    return false;
  }

  async measureDiff(_since: string): Promise<{ added: number; removed: number; total: number }> {
    return { ...this.diffStats };
  }
}
