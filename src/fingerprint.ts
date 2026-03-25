import { access, readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const run = promisify(execFile);

export type ProjectProfile = {
  readonly stack?: string;
  readonly testCommand?: string;
};

export type FingerprintResult = {
  readonly brief: string;
  readonly profile: ProjectProfile;
};

export type FingerprintOptions = {
  readonly cwd: string;
  readonly processPath: string;
  readonly outputDir: string;
  readonly skip?: boolean;
};

const DEFAULTS: FingerprintResult = { brief: '', profile: {} };

const processExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const loadBrief = async (outputDir: string): Promise<string> => {
  try {
    const text = await readFile(join(outputDir, 'brief.md'), 'utf-8');
    return text.trim();
  } catch {
    return '';
  }
};

const loadProfile = async (outputDir: string): Promise<ProjectProfile> => {
  try {
    const text = await readFile(join(outputDir, 'profile.json'), 'utf-8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    return {
      ...(typeof obj.stack === 'string' ? { stack: obj.stack } : {}),
      ...(typeof obj.testCommand === 'string' ? { testCommand: obj.testCommand } : {}),
    };
  } catch {
    return {};
  }
};

export const runFingerprint = async (opts: FingerprintOptions): Promise<FingerprintResult> => {
  if (opts.skip) return DEFAULTS;
  if (!await processExists(opts.processPath)) return DEFAULTS;

  try {
    await run(opts.processPath, [], { cwd: opts.cwd });
  } catch {
    return DEFAULTS;
  }

  const [brief, profile] = await Promise.all([
    loadBrief(opts.outputDir),
    loadProfile(opts.outputDir),
  ]);

  return { brief, profile };
};

export const wrapBrief = (brief: string): string => {
  if (!brief) return '';
  return `<codebase-brief>\n${brief}\n</codebase-brief>`;
};
