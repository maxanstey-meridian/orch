import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dequeueNext } from "#infrastructure/queue/queue-store.js";
import { pruneDeadEntries } from "#infrastructure/registry/run-registry.js";

export type Supervisor = {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
};

type CreateSupervisorOptions = {
  readonly registryPath: string;
  readonly queuePath: string;
  readonly concurrencyLimit?: number;
  readonly orchBin: string;
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
  readonly #orchBin: string;
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
    this.#orchBin = options.orchBin;
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

    const { alive } = await pruneDeadEntries(this.#registryPath);
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

    const child = this.#spawnChild(
      "node",
      [this.#orchBin, "work", nextEntry.planPath, ...nextEntry.flags],
      {
        cwd: nextEntry.repo,
        stdio: "ignore",
        detached: true,
      },
    );

    const childPid = child.pid;
    if (typeof childPid === "number" && childPid > 0) {
      this.#spawnedChildPids.add(childPid);
    }

    child.on("exit", () => {
      if (typeof childPid === "number" && childPid > 0) {
        this.#spawnedChildPids.delete(childPid);
      }
      this.#requestPoll();
    });
    child.unref();
  }
}

export const createSupervisor = (
  options: CreateSupervisorOptions,
): Supervisor => {
  return new DashboardSupervisor(options, {
    spawnChild: (command, args, spawnOptions) => spawn(command, [...args], spawnOptions),
  });
};
