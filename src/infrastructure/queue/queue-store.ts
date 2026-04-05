import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { QueueEntry } from "#domain/queue.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasCode = (value: unknown): value is { readonly code: string } =>
  isRecord(value) && typeof value.code === "string";

const createCorruptQueueError = (queuePath: string): Error =>
  new Error(`Queue file is corrupt: ${queuePath}`);

const LOCK_OWNER_FILE = "owner.json";
const lockRetryDelayMs = 10;
const staleLockAgeMs = 60_000;
const pendingMutations = new Map<string, Promise<void>>();

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });

const isQueueEntry = (value: unknown): value is QueueEntry => {
  if (!isRecord(value)) {
    return false;
  }

  const { id, repo, planPath, branch, flags, addedAt } = value;
  if (typeof id !== "string") {
    return false;
  }
  if (typeof repo !== "string") {
    return false;
  }
  if (typeof planPath !== "string") {
    return false;
  }
  if (typeof addedAt !== "string") {
    return false;
  }
  if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === "string")) {
    return false;
  }

  return branch === undefined || typeof branch === "string";
};

const lockPathForQueue = (queuePath: string): string => `${queuePath}.lock`;

const tempPathForQueue = (queuePath: string): string =>
  `${queuePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

const isLockMetadata = (
  value: unknown,
): value is { readonly pid: number; readonly createdAtMs: number } => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.createdAtMs === "number" &&
    Number.isFinite(value.createdAtMs)
  );
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(hasCode(error) && error.code === "ESRCH");
  }
};

const writeLockMetadata = async (lockPath: string): Promise<void> => {
  await mkdir(lockPath);
  try {
    await writeFile(
      join(lockPath, LOCK_OWNER_FILE),
      JSON.stringify({
        pid: process.pid,
        createdAtMs: Date.now(),
      }),
      { flag: "wx" },
    );
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
};

const readLockMetadata = async (
  lockPath: string,
): Promise<{ readonly pid: number; readonly createdAtMs: number } | undefined> => {
  try {
    const raw = await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isLockMetadata(parsed) ? parsed : undefined;
  } catch (error) {
    if (
      hasCode(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")
    ) {
      try {
        const raw = await readFile(lockPath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        return isLockMetadata(parsed) ? parsed : undefined;
      } catch (legacyError) {
        if (
          hasCode(legacyError) &&
          (legacyError.code === "ENOENT" || legacyError.code === "EISDIR")
        ) {
          return undefined;
        }

        return undefined;
      }
    }

    return undefined;
  }
};

const isStaleLock = async (lockPath: string): Promise<boolean> => {
  let lockStats;
  try {
    lockStats = await stat(lockPath);
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  const lockMetadata = await readLockMetadata(lockPath);
  if (lockMetadata !== undefined) {
    return !isProcessAlive(lockMetadata.pid);
  }

  return Date.now() - lockStats.mtimeMs >= staleLockAgeMs;
};

const clearStaleLock = async (lockPath: string): Promise<boolean> => {
  try {
    if (!(await isStaleLock(lockPath))) {
      return false;
    }
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  await rm(lockPath, { recursive: true, force: true });
  return true;
};

const releaseLock = async (lockPath: string): Promise<void> => {
  await rm(join(lockPath, LOCK_OWNER_FILE), { force: true });
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (hasCode(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) {
      return;
    }

    throw error;
  }
};

const writeQueue = async (queuePath: string, entries: QueueEntry[]): Promise<void> => {
  await mkdir(dirname(queuePath), { recursive: true });
  const tempPath = tempPathForQueue(queuePath);
  try {
    await writeFile(tempPath, JSON.stringify(entries, null, 2));
    await rename(tempPath, queuePath);
  } finally {
    await rm(tempPath, { force: true });
  }
};

export const defaultQueuePath = (): string => join(homedir(), ".orch", "queue.json");

const loadQueue = async (
  queuePath: string,
  options: { readonly throwOnCorrupt: boolean },
): Promise<QueueEntry[]> => {
  let raw: string;
  try {
    raw = await readFile(queuePath, "utf8");
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
    if (options.throwOnCorrupt) {
      throw createCorruptQueueError(queuePath);
    }

    return [];
  }

  if (!Array.isArray(parsed)) {
    if (options.throwOnCorrupt) {
      throw createCorruptQueueError(queuePath);
    }

    return [];
  }

  if (!parsed.every(isQueueEntry)) {
    if (options.throwOnCorrupt) {
      throw createCorruptQueueError(queuePath);
    }

    return [];
  }

  return parsed;
};

export const readQueue = async (queuePath: string): Promise<QueueEntry[]> => {
  return loadQueue(queuePath, { throwOnCorrupt: false });
};

const withFileLock = async <T>(queuePath: string, operation: () => Promise<T>): Promise<T> => {
  const lockPath = lockPathForQueue(queuePath);
  await mkdir(dirname(queuePath), { recursive: true });

  while (true) {
    try {
      await writeLockMetadata(lockPath);
      break;
    } catch (error) {
      if (!hasCode(error) || (error.code !== "EEXIST" && error.code !== "ENOENT")) {
        throw error;
      }

      const clearedLock = await clearStaleLock(lockPath);
      if (!clearedLock) {
        await sleep(lockRetryDelayMs);
      }
    }
  }

  try {
    return await operation();
  } finally {
    await releaseLock(lockPath);
  }
};

const withMutationLock = async <T>(queuePath: string, operation: () => Promise<T>): Promise<T> => {
  const previousMutation = pendingMutations.get(queuePath) ?? Promise.resolve();
  let releaseMutation!: () => void;
  const currentMutation = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  pendingMutations.set(queuePath, currentMutation);

  await previousMutation;

  try {
    return await withFileLock(queuePath, operation);
  } finally {
    releaseMutation();
    if (pendingMutations.get(queuePath) === currentMutation) {
      pendingMutations.delete(queuePath);
    }
  }
};

export const addToQueue = async (queuePath: string, entry: QueueEntry): Promise<void> => {
  await withMutationLock(queuePath, async () => {
    const entries = await loadQueue(queuePath, { throwOnCorrupt: true });
    await writeQueue(queuePath, [...entries, entry]);
  });
};

export const removeFromQueue = async (queuePath: string, id: string): Promise<void> => {
  await withMutationLock(queuePath, async () => {
    const entries = await loadQueue(queuePath, { throwOnCorrupt: true });
    const remainingEntries = entries.filter((entry) => entry.id !== id);
    if (remainingEntries.length === entries.length) {
      return;
    }

    await writeQueue(queuePath, remainingEntries);
  });
};

export const moveInQueue = async (
  queuePath: string,
  id: string,
  position: number,
): Promise<void> => {
  await withMutationLock(queuePath, async () => {
    const entries = await loadQueue(queuePath, { throwOnCorrupt: true });
    const entryIndex = entries.findIndex((entry) => entry.id === id);
    if (entryIndex === -1) {
      return;
    }

    const entry = entries[entryIndex];
    const remainingEntries = entries.filter((_, index) => index !== entryIndex);
    const clampedPosition = Math.max(0, Math.min(position, remainingEntries.length));
    const reorderedEntries = [...remainingEntries];
    reorderedEntries.splice(clampedPosition, 0, entry);

    await writeQueue(queuePath, reorderedEntries);
  });
};

export const dequeueNext = async (queuePath: string): Promise<QueueEntry | undefined> => {
  return withMutationLock(queuePath, async () => {
    const entries = await loadQueue(queuePath, { throwOnCorrupt: true });
    if (entries.length === 0) {
      return undefined;
    }

    const [nextEntry, ...remainingEntries] = entries;
    await writeQueue(queuePath, remainingEntries);
    return nextEntry;
  });
};
