export abstract class GitOps {
  abstract captureRef(): Promise<string>;
  abstract hasChanges(since: string): Promise<boolean>;
  abstract hasDirtyTree(): Promise<boolean>;
  abstract getStatus(): Promise<string>;
  abstract stashBackup(): Promise<boolean>;
  // Port uses short names (added/removed); adapter maps from DiffStats (linesAdded/linesRemoved).
  abstract measureDiff(
    since: string,
  ): Promise<{ added: number; removed: number; total: number }>;
}
