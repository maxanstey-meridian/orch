import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueEntry } from "#domain/queue.js";
import { addToQueue } from "#infrastructure/queue/queue-store.js";
import { createSupervisor } from "#infrastructure/dashboard/supervisor.js";
import { pruneDeadEntries } from "#infrastructure/registry/run-registry.js";
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
  flags: [],
  addedAt: "2026-04-10T10:00:00.000Z",
  ...overrides,
});

let tempDir: string;
let queuePath: string;
let registryPath: string;

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

describe("Dashboard queue launch lifecycle", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orch-dashboard-queue-lifecycle-"));
    queuePath = join(tempDir, "queue.json");
    registryPath = join(tempDir, "runs.json");
    pruneDeadEntriesMock.mockResolvedValue({
      alive: [],
      dead: [],
    });
    spawnMock.mockImplementation(
      () => new FakeChildProcess(2_000) as unknown as ChildProcess,
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("forces detached dashboard-launched work runs into --auto mode", async () => {
    await addToQueue(queuePath, makeQueueEntry());

    const supervisor = createSupervisor({
      registryPath,
      queuePath,
      launchCommand: "node",
      launchArgs: ["/dist/main.js"],
    });

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

    supervisor.stop();
  });
});
