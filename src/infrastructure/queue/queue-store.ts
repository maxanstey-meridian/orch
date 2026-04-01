import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { QueueEntry } from "#domain/queue.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasCode = (value: unknown): value is { readonly code: string } =>
  isRecord(value) && typeof value.code === "string";

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

const writeQueue = async (queuePath: string, entries: QueueEntry[]): Promise<void> => {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, JSON.stringify(entries, null, 2));
};

export const defaultQueuePath = (): string => join(homedir(), ".orch", "queue.json");

export const readQueue = async (queuePath: string): Promise<QueueEntry[]> => {
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
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.every(isQueueEntry) ? parsed : [];
};

export const addToQueue = async (queuePath: string, entry: QueueEntry): Promise<void> => {
  const entries = await readQueue(queuePath);
  await writeQueue(queuePath, [...entries, entry]);
};

export const removeFromQueue = async (queuePath: string, id: string): Promise<void> => {
  const entries = await readQueue(queuePath);
  const remainingEntries = entries.filter((entry) => entry.id !== id);
  if (remainingEntries.length === entries.length) {
    return;
  }

  await writeQueue(queuePath, remainingEntries);
};

export const moveInQueue = async (queuePath: string, id: string, position: number): Promise<void> => {
  const entries = await readQueue(queuePath);
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
};

export const dequeueNext = async (queuePath: string): Promise<QueueEntry | undefined> => {
  const entries = await readQueue(queuePath);
  if (entries.length === 0) {
    return undefined;
  }

  const [nextEntry, ...remainingEntries] = entries;
  await writeQueue(queuePath, remainingEntries);
  return nextEntry;
};
