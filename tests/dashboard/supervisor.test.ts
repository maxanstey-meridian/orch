import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueEntry } from "#domain/queue.js";
import { addToQueue, readQueue } from "#infrastructure/queue/queue-store.js";
import type { Supervisor } from "#infrastructure/dashboard/supervisor.js";
import { createSupervisor, supervisorPollIntervalMs } from "#infrastructure/dashboard/supervisor.js";
import { pruneDeadEntries, writeRegistry } from "#infrastructure/registry/run-registry.js";
import type { RunEntry } from "#domain/registry.js";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("#infrastructure/registry/run-registry.js", async () => {
  const actual =
    await vi.importActual<typeof import("#infrastructure/registry/run-registry.js")>(
      "#infrastructure/registry/run-registry.js",
    );

  return {
    ...actual,
    pruneDeadEntries: vi.fn(),
  };
});

class FakeChildProcess extends EventEmitter {
  readonly pid: number;
  readonly unref = vi.fn();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

const spawnMock = vi.mocked(spawn);
const pruneDeadEntriesMock = vi.mocked(pruneDeadEntries);

const makeQueueEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: "queue-1",
  repo: "/repos/orch",
  planPath: "/plans/demo.json",
  flags: ["--auto"],
  addedAt: "2026-04-10T10:00:00.000Z",
  ...overrides,
});

let tempDir: string;
let queuePath: string;
let registryPath: string;
let aliveEntries: RunEntry[];
let nextPid: number;
const activeSupervisors: Supervisor[] = [];

const createSpawnedChild = (): FakeChildProcess => {
  const child = new FakeChildProcess(nextPid);
  nextPid += 1;
  return child;
};

const waitForExpectation = async (
  expectation: () => void,
  timeoutMs = 500,
): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      expectation();
      return;
    } catch {
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 0);
      });
    }
  }

  expectation();
};

const waitForQueueEntries = async (
  expectedEntries: QueueEntry[],
  timeoutMs = 500,
): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentEntries = await readQueue(queuePath);
    if (JSON.stringify(currentEntries) === JSON.stringify(expectedEntries)) {
      return;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 0);
    });
  }

  expect(await readQueue(queuePath)).toEqual(expectedEntries);
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-supervisor-test-"));
  queuePath = join(tempDir, "queue.json");
  registryPath = join(tempDir, "runs.json");
  aliveEntries = [];
  nextPid = 2_000;
  pruneDeadEntriesMock.mockImplementation(async () => ({
    alive: aliveEntries,
    dead: [],
  }));
  spawnMock.mockImplementation(() => createSpawnedChild() as unknown as ChildProcess);
});

afterEach(async () => {
  for (const supervisor of activeSupervisors.splice(0)) {
    supervisor.stop();
  }
  vi.useRealTimers();
  vi.clearAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

const createTestSupervisor = (): Supervisor => {
  const supervisor = createSupervisor({
    registryPath,
    queuePath,
    launchCommand: "node",
    launchArgs: ["/dist/main.js"],
  });
  activeSupervisors.push(supervisor);
  return supervisor;
};

describe("createSupervisor", () => {
  it("passes a queued branch through to the spawned work command", async () => {
    await addToQueue(
      queuePath,
      makeQueueEntry({
        branch: "feature/dashboard",
        flags: [],
      }),
    );

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    const spawnedArgs = spawnMock.mock.calls[0]?.[1] ?? [];
    expect(spawnedArgs).toContain("--auto");
    expect(spawnedArgs).toContain("--branch");
    expect(spawnedArgs).toContain("feature/dashboard");
  });

  it("dequeues and spawns a child process when below the concurrency limit", async () => {
    await addToQueue(queuePath, makeQueueEntry());

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      ["/dist/main.js", "work", "/plans/demo.json", "--auto"],
      {
        cwd: "/repos/orch",
        stdio: "ignore",
        detached: true,
      },
    );
    expect(await readQueue(queuePath)).toEqual([]);
  });

  it("injects --auto for detached queued runs when the stored entry has no flags", async () => {
    await addToQueue(queuePath, makeQueueEntry({ flags: [] }));

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      ["/dist/main.js", "work", "/plans/demo.json", "--auto"],
      {
        cwd: "/repos/orch",
        stdio: "ignore",
        detached: true,
      },
    );
  });

  it("does not spawn when the registry is already at the concurrency limit", async () => {
    await addToQueue(queuePath, makeQueueEntry());
    aliveEntries = [
      {
        id: "run-1",
        pid: 123,
        repo: "/repos/orch",
        planPath: "/plans/demo.json",
        statePath: "/state/plan-1.json",
        startedAt: "2026-04-10T10:00:00.000Z",
      },
    ];

    const supervisor = createTestSupervisor();

    supervisor.start();
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(await readQueue(queuePath)).toEqual([makeQueueEntry()]);
  });

  it("spawns the next queued entry after a child exits", async () => {
    await addToQueue(queuePath, makeQueueEntry({ id: "queue-1", planPath: "/plans/one.json" }));
    await addToQueue(queuePath, makeQueueEntry({ id: "queue-2", planPath: "/plans/two.json" }));

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    const firstChild = spawnMock.mock.results[0]?.value as unknown as FakeChildProcess;

    firstChild.emit("exit", 0);
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    expect(spawnMock.mock.calls[1]).toEqual([
      "node",
      ["/dist/main.js", "work", "/plans/two.json", "--auto"],
      {
        cwd: "/repos/orch",
        stdio: "ignore",
        detached: true,
      },
    ]);
  });

  it("leaves the queued entry in place when spawning the child throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await addToQueue(queuePath, makeQueueEntry());
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(errorSpy).toHaveBeenCalled();
    });

    expect(await readQueue(queuePath)).toEqual([makeQueueEntry()]);
  });

  it("requeues the entry when the spawned child emits an error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await addToQueue(queuePath, makeQueueEntry());

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    const firstChild = spawnMock.mock.results[0]?.value as unknown as FakeChildProcess;

    let emittedError: unknown;
    try {
      firstChild.emit("error", new Error("child failed to launch"));
    } catch (error) {
      emittedError = error;
    }

    expect(emittedError).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    await waitForQueueEntries([makeQueueEntry()]);
  });

  it("children are spawned detached and unrefed", async () => {
    await addToQueue(queuePath, makeQueueEntry());

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    const firstChild = spawnMock.mock.results[0]?.value as unknown as FakeChildProcess;

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      ["/dist/main.js", "work", "/plans/demo.json", "--auto"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(firstChild.unref).toHaveBeenCalledTimes(1);
  });

  it("start is idempotent and does not create duplicate polling loops", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval"],
    });
    await addToQueue(queuePath, makeQueueEntry());

    const supervisor = createTestSupervisor();

    supervisor.start();
    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    const firstChild = spawnMock.mock.results[0]?.value as unknown as FakeChildProcess;
    await vi.advanceTimersByTimeAsync(supervisorPollIntervalMs);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(supervisor.isRunning).toBe(true);

    firstChild.emit("exit", 0);
  });

  it("does not over-dequeue on an interval tick while a spawned child is not yet in the registry", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval"],
    });
    await addToQueue(queuePath, makeQueueEntry({ id: "queue-1", planPath: "/plans/one.json" }));
    await addToQueue(queuePath, makeQueueEntry({ id: "queue-2", planPath: "/plans/two.json" }));

    const supervisor = createTestSupervisor();

    supervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    const firstChild = spawnMock.mock.results[0]?.value as unknown as FakeChildProcess;

    await vi.advanceTimersByTimeAsync(supervisorPollIntervalMs);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(await readQueue(queuePath)).toEqual([
      makeQueueEntry({ id: "queue-2", planPath: "/plans/two.json" }),
    ]);

    firstChild.emit("exit", 0);
  });

  it("does not oversubscribe the concurrency limit across two dashboard supervisors", async () => {
    await addToQueue(queuePath, makeQueueEntry({ id: "queue-1", planPath: "/plans/one.json" }));
    await addToQueue(queuePath, makeQueueEntry({ id: "queue-2", planPath: "/plans/two.json" }));

    const firstSupervisor = createTestSupervisor();
    const secondSupervisor = createTestSupervisor();

    firstSupervisor.start();
    await waitForExpectation(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    secondSupervisor.start();
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 25);
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const firstChild = spawnMock.mock.results[0]?.value as unknown as FakeChildProcess;
    await writeRegistry(registryPath, [
      {
        id: "run-1",
        pid: firstChild.pid,
        repo: "/repos/orch",
        planPath: "/plans/one.json",
        statePath: "/state/plan-1.json",
        startedAt: "2026-04-10T10:00:00.000Z",
      },
    ]);
    aliveEntries = [
      {
        id: "run-1",
        pid: firstChild.pid,
        repo: "/repos/orch",
        planPath: "/plans/one.json",
        statePath: "/state/plan-1.json",
        startedAt: "2026-04-10T10:00:00.000Z",
      },
    ];

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 50);
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(await readQueue(queuePath)).toEqual([
      makeQueueEntry({ id: "queue-2", planPath: "/plans/two.json" }),
    ]);
  });

  it("does not spawn after stop is called while a poll is already in flight", async () => {
    await addToQueue(queuePath, makeQueueEntry());
    let resolvePrune:
      | ((value: { alive: RunEntry[]; dead: RunEntry[] }) => void)
      | undefined;
    pruneDeadEntriesMock.mockImplementationOnce(
      () =>
        new Promise((resolvePromise) => {
          resolvePrune = resolvePromise;
        }),
    );

    const supervisor = createTestSupervisor();

    supervisor.start();
    await Promise.resolve();
    supervisor.stop();
    resolvePrune?.({ alive: [], dead: [] });
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 20);
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(await readQueue(queuePath)).toEqual([makeQueueEntry()]);
  });

  it("stop clears the polling interval", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval"],
    });
    const supervisor = createTestSupervisor();

    supervisor.start();
    await Promise.resolve();
    supervisor.stop();
    await addToQueue(queuePath, makeQueueEntry());
    await vi.advanceTimersByTimeAsync(supervisorPollIntervalMs);

    expect(spawnMock).not.toHaveBeenCalled();
  });

});
