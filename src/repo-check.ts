import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

export const assertGitRepo = async (cwd: string): Promise<void> => {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch {
    throw new Error(
      'Not a git repository. The orchestrator requires git for change tracking.\nRun: git init && git commit --allow-empty -m "init"',
    );
  }

  try {
    await run('git', ['rev-parse', 'HEAD'], { cwd });
  } catch {
    throw new Error(
      'Git repository has no commits. At least one commit is required.\nRun: git commit --allow-empty -m "init"',
    );
  }
};
