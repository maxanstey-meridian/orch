import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

export type DiffStats = { linesAdded: number; linesRemoved: number; total: number };

const ZERO_STATS: DiffStats = { linesAdded: 0, linesRemoved: 0, total: 0 };

const parseDiffStat = (output: string): DiffStats => {
  // Match the summary line: "3 files changed, 45 insertions(+), 12 deletions(-)"
  const insertions = output.match(/(\d+) insertion/);
  const deletions = output.match(/(\d+) deletion/);
  const added = insertions ? Number(insertions[1]) : 0;
  const removed = deletions ? Number(deletions[1]) : 0;
  return { linesAdded: added, linesRemoved: removed, total: added + removed };
};

export const measureDiff = async (cwd: string, since: string): Promise<DiffStats> => {
  try {
    const [committed, uncommitted] = await Promise.all([
      run("git", ["diff", "--stat", `${since}..HEAD`], { cwd })
        .then((r) => r.stdout)
        .catch(() => ""),
      run("git", ["diff", "HEAD", "--stat"], { cwd })
        .then((r) => r.stdout)
        .catch(() => ""),
    ]);

    const c = parseDiffStat(committed);
    const u = parseDiffStat(uncommitted);

    return {
      linesAdded: c.linesAdded + u.linesAdded,
      linesRemoved: c.linesRemoved + u.linesRemoved,
      total: c.total + u.total,
    };
  } catch {
    return ZERO_STATS;
  }
};

export const shouldReview = (stats: DiffStats, threshold = 30): boolean => stats.total >= threshold;
