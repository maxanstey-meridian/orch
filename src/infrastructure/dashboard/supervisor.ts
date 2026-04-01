import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QueueEntry } from "#domain/queue.js";
import { addToQueue, dequeueNext } from "#infrastructure/queue/queue-store.js";
import { pruneDeadEntries, readRegistry } from "#infrastructure/registry/run-registry.js";

export type Supervisor = {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
};

type CreateSupervisorOptions = {
  readonly registryPath: string;
  readonly queuePath: string;
  readonly concurrencyLimit?: number;
  readonly launchCommand: string;
  readonly launchArgs: readonly string[];
};

type ChildProcessSpawner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly stdio: "ignore";
    readonly detached: true;
  },
) => ChildProcess;

export const supervisorPollIntervalMs = 5_000;
const supervisorLockOwnerFile = "owner.json";
const supervisorLockStaleMs = 60_000;
const childRegistrationPollMs = 25;
const childRegistrationTimeoutMs = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasCode = (value: unknown): value is { readonly code: string } =>
  isRecord(value) && typeof value.code === "string";

const delay = async (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });

const hasResolvedBranchFlag = (flags: readonly string[]): boolean => {
  const branchIndex = flags.indexOf("--branch");
  if (branchIndex === -1) {
    return false;
  }

  const branchValue = flags[branchIndex + 1];
  return typeof branchValue === "string" && branchValue.length > 0 && !branchValue.startsWith("-");
};

const buildWorkCommandArgs = (
  launchArgs: readonly string[],
  entry: QueueEntry,
): string[] => {
  const flags = [...entry.flags];
  if (entry.branch !== undefined && !hasResolvedBranchFlag(flags)) {
    flags.push("--branch", entry.branch);
  }

  return [...launchArgs, "work", entry.planPath, ...flags];
};

const countTrackedChildrenMissingFromRegistry = (
  alivePids: readonly number[],
  trackedPids: ReadonlySet<number>,
): number => {
  return [...trackedPids].filter((pid) => !alivePids.includes(pid)).length;
};

class DashboardSupervisor implements Supervisor {
  readonly #registryPath: string;
  readonly #queuePath: string;
  readonly #concurrencyLimit: number;
  readonly #launchCommand: string;
  readonly #launchArgs: readonly string[];
  readonly #spawnChild: ChildProcessSpawner;

  #isRunning = false;
  #intervalHandle: NodeJS.Timeout | undefined;
  #pollInFlight: Promise<void> | undefined;
  #pollQueued = false;
  readonly #spawnedChildPids = new Set<number>();

  constructor(
    options: CreateSupervisorOptions,
    dependencies: { readonly spawnChild: ChildProcessSpawner },
  ) {
    this.#registryPath = options.registryPath;
    this.#queuePath = options.queuePath;
    this.#concurrencyLimit = options.concurrencyLimit ?? 1;
    this.#launchCommand = options.launchCommand;
    this.#launchArgs = options.launchArgs;
    this.#spawnChild = dependencies.spawnChild;
  }

  get isRunning(): boolean {
    return this.#isRunning;
  }

  start(): void {
    if (this.#isRunning) {
      return;
    }

    this.#isRunning = true;
    this.#intervalHandle = setInterval(() => {
      this.#requestPoll();
    }, supervisorPollIntervalMs);
    this.#requestPoll();
  }

  stop(): void {
    if (!this.#isRunning) {
      return;
    }

    this.#isRunning = false;
    this.#pollQueued = false;
    if (this.#intervalHandle !== undefined) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = undefined;
    }
  }

  #requestPoll(): void {
    if (!this.#isRunning) {
      return;
    }

    if (this.#pollInFlight !== undefined) {
      this.#pollQueued = true;
      return;
    }

    this.#pollInFlight = this.#runPollLoop()
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => {
        this.#pollInFlight = undefined;
        if (this.#pollQueued && this.#isRunning) {
          this.#pollQueued = false;
          this.#requestPoll();
        }
      });
  }

  async #runPollLoop(): Promise<void> {
    do {
      this.#pollQueued = false;
      await this.#pollOnce();
    } while (this.#pollQueued && this.#isRunning);
  }

  async #pollOnce(): Promise<void> {
    if (!this.#isRunning) {
      return;
    }

    await this.#withDispatchLock(async () => {
      if (!this.#isRunning) {
        return;
      }

      const { alive } = await pruneDeadEntries(this.#registryPath);
      if (!this.#isRunning) {
        return;
      }

      const alivePids = alive.map((entry) => entry.pid);
      const activeRunCount =
        alive.length +
        countTrackedChildrenMissingFromRegistry(alivePids, this.#spawnedChildPids);
      if (activeRunCount >= this.#concurrencyLimit) {
        return;
      }

      const nextEntry = await dequeueNext(this.#queuePath);
      if (nextEntry === undefined) {
        return;
      }
      if (!this.#isRunning) {
        await addToQueue(this.#queuePath, nextEntry);
        return;
      }

      let child: ChildProcess;
      try {
        child = this.#spawnChild(this.#launchCommand, buildWorkCommandArgs(this.#launchArgs, nextEntry), {
          cwd: nextEntry.repo,
          stdio: "ignore",
          detached: true,
        });
      } catch (error) {
        await addToQueue(this.#queuePath, nextEntry);
        throw error;
      }

      const childPid = child.pid;
      if (typeof childPid === "number" && childPid > 0) {
        this.#spawnedChildPids.add(childPid);
      }

      let restoredEntry = false;
      let settleChildState: () => void = () => {};
      const childSettled = new Promise<void>((resolvePromise) => {
        settleChildState = resolvePromise;
      });
      const restoreEntry = async (): Promise<void> => {
        if (restoredEntry) {
          return;
        }

        restoredEntry = true;
        if (typeof childPid === "number" && childPid > 0) {
          this.#spawnedChildPids.delete(childPid);
        }
        settleChildState();
        await addToQueue(this.#queuePath, nextEntry);
      };

      child.on("error", (error) => {
        void restoreEntry().catch((restoreError: unknown) => {
          console.error(restoreError);
        });
        console.error(error);
      });

      child.on("exit", () => {
        if (typeof childPid === "number" && childPid > 0) {
          this.#spawnedChildPids.delete(childPid);
        }
        settleChildState();
        if (!restoredEntry) {
          this.#requestPoll();
        }
      });
      child.unref();

      await this.#waitForChildRegistration(childPid, childSettled);
    });
  }

  async #waitForChildRegistration(
    childPid: number | undefined,
    childSettled: Promise<void>,
  ): Promise<void> {
    if (typeof childPid !== "number" || childPid <= 0) {
      return;
    }

    const deadline = Date.now() + childRegistrationTimeoutMs;
    while (Date.now() < deadline && this.#isRunning) {
      const entries = await readRegistry(this.#registryPath);
      if (entries.some((entry) => entry.pid === childPid)) {
        return;
      }

      const childState = await Promise.race([
        childSettled.then(() => "settled" as const),
        delay(childRegistrationPollMs).then(() => "pending" as const),
      ]);
      if (childState === "settled") {
        return;
      }
    }
  }

  async #withDispatchLock(work: () => Promise<void>): Promise<void> {
    const lockPath = `${this.#queuePath}.supervisor.lock`;
    await mkdir(dirname(this.#queuePath), { recursive: true });

    for (;;) {
      try {
        await mkdir(lockPath);
        await writeFile(
          join(lockPath, supervisorLockOwnerFile),
          JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }),
        );
        break;
      } catch (error) {
        if (hasCode(error) && error.code === "EEXIST") {
          if (await this.#removeStaleDispatchLock(lockPath)) {
            continue;
          }

          await delay(5);
          continue;
        }

        throw error;
      }
    }

    try {
      await work();
    } finally {
      await rm(lockPath, { force: true, recursive: true });
    }
  }

  async #removeStaleDispatchLock(lockPath: string): Promise<boolean> {
    const owner = await this.#readDispatchLockOwner(lockPath);
    if (owner !== undefined) {
      if (this.#isProcessAlive(owner.pid)) {
        return false;
      }

      await rm(lockPath, { force: true, recursive: true });
      return true;
    }

    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs < supervisorLockStaleMs) {
        return false;
      }

      await rm(lockPath, { force: true, recursive: true });
      return true;
    } catch (error) {
      if (hasCode(error) && error.code === "ENOENT") {
        return true;
      }

      throw error;
    }
  }

  async #readDispatchLockOwner(
    lockPath: string,
  ): Promise<{ readonly pid: number; readonly acquiredAt: string } | undefined> {
    try {
      const raw = await readFile(join(lockPath, supervisorLockOwnerFile), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        isRecord(parsed) &&
        typeof parsed.pid === "number" &&
        typeof parsed.acquiredAt === "string"
      ) {
        return {
          pid: parsed.pid,
          acquiredAt: parsed.acquiredAt,
        };
      }

      return undefined;
    } catch (error) {
      if (hasCode(error) && error.code === "ENOENT") {
        return undefined;
      }

      return undefined;
    }
  }

  #isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !(hasCode(error) && error.code === "ESRCH");
    }
  }
}

export const createSupervisor = (
  options: CreateSupervisorOptions,
): Supervisor => {
  return new DashboardSupervisor(options, {
    spawnChild: (command, args, spawnOptions) => spawn(command, [...args], spawnOptions),
  });
};
