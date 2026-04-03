import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { RunEntry } from "#domain/registry.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasCode = (value: unknown): value is { readonly code: string } =>
  isRecord(value) && typeof value.code === "string";

const isRunEntry = (value: unknown): value is RunEntry => {
  if (!isRecord(value)) {
    return false;
  }

  const { id, pid, repo, planPath, statePath, branch, startedAt } = value;
  if (typeof id !== "string") {
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (typeof repo !== "string") {
    return false;
  }
  if (typeof planPath !== "string") {
    return false;
  }
  if (typeof statePath !== "string") {
    return false;
  }
  if (typeof startedAt !== "string") {
    return false;
  }

  return branch === undefined || typeof branch === "string";
};

export const defaultRegistryPath = (): string => join(homedir(), ".orch", "runs.json");

export const readRegistry = async (registryPath: string): Promise<RunEntry[]> => {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.every(isRunEntry) ? parsed : [];
};

export const writeRegistry = async (registryPath: string, entries: RunEntry[]): Promise<void> => {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify(entries, null, 2));
};

export const registerRun = async (registryPath: string, entry: RunEntry): Promise<void> => {
  const entries = await readRegistry(registryPath);
  await writeRegistry(registryPath, [...entries, entry]);
};

export const deregisterRun = async (registryPath: string, id: string): Promise<void> => {
  const entries = await readRegistry(registryPath);
  const remainingEntries = entries.filter((entry) => entry.id !== id);
  if (remainingEntries.length === entries.length) {
    return;
  }

  await writeRegistry(registryPath, remainingEntries);
};

const LOCK_OWNER_FILE = "owner.json";

const delay = async (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });

const removeStaleRegistryLock = async (lockPath: string): Promise<boolean> => {
  try {
    const raw = await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8").catch(() => "");
    const parsed = raw ? (JSON.parse(raw) as { pid?: unknown }) : {};
    const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        // owner is gone; remove stale lock below
      }
    }

    await rm(lockPath, { force: true, recursive: true });
    return true;
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }
};

export const withRegistryLock = async <T>(
  registryPath: string,
  work: () => Promise<T>,
): Promise<T> => {
  const lockPath = `${registryPath}.lock`;
  await mkdir(dirname(registryPath), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, LOCK_OWNER_FILE),
        JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
      );
      break;
    } catch (error) {
      if (hasCode(error) && error.code === "EEXIST") {
        if (await removeStaleRegistryLock(lockPath)) {
          continue;
        }

        await delay(5);
        continue;
      }

      throw error;
    }
  }

  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
};

export const removeRunFromRegistry = async (registryPath: string, id: string): Promise<void> =>
  withRegistryLock(registryPath, async () => {
    await deregisterRun(registryPath, id);
  });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const pruneDeadEntries = async (
  registryPath: string,
): Promise<{ alive: RunEntry[]; dead: RunEntry[] }> => {
  const entries = await readRegistry(registryPath);
  const alive: RunEntry[] = [];
  const dead: RunEntry[] = [];

  for (const entry of entries) {
    if (isAlive(entry.pid)) {
      alive.push(entry);
      continue;
    }

    dead.push(entry);
  }

  return { alive, dead };
};
