import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEntry } from "#domain/registry.js";
import { aggregateDashboard, formatElapsed } from "#infrastructure/dashboard/data-aggregator.js";
import { addToQueue } from "#infrastructure/queue/queue-store.js";
import { writeRegistry } from "#infrastructure/registry/run-registry.js";

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
};

const makePlan = () => ({
  groups: [
    {
      name: "Dashboard",
      slices: [
        {
          number: 1,
          title: "Registry",
          why: "Track active runs",
          files: [{ path: "src/a.ts", action: "new" }],
          details: "Implement registry",
          tests: "Test registry",
        },
        {
          number: 2,
          title: "Aggregator",
          why: "Show run status",
          files: [{ path: "src/b.ts", action: "new" }],
          details: "Implement aggregator",
          tests: "Test aggregator",
        },
      ],
    },
  ],
});

const makeRunEntry = (overrides: Partial<RunEntry> = {}): RunEntry => ({
  id: "run-1",
  pid: process.pid,
  repo: "/repos/orch",
  planPath: "/plans/plan.json",
  statePath: "/state/run.json",
  startedAt: "2026-04-10T10:00:00.000Z",
  ...overrides,
});

const makeQueueEntry = (overrides: Record<string, unknown> = {}) => ({
  id: "queue-1",
  repo: "/repos/queued",
  planPath: "/plans/queued-plan.json",
  flags: ["--auto"],
  addedAt: "2026-04-10T09:00:00.000Z",
  ...overrides,
});

describe("data aggregator", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dashboard-data-aggregator-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty model when no registry file exists", async () => {
    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");

    await expect(aggregateDashboard(registryPath, queuePath)).resolves.toEqual({
      active: [],
      queued: [],
      completed: [],
    });
  });

  it("formatElapsed produces human-readable strings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    expect(formatElapsed("2026-04-10T11:59:30.000Z")).toBe("<1m");
    expect(formatElapsed("2026-04-10T11:58:30.000Z")).toBe("1m");
    expect(formatElapsed("2026-04-10T10:58:59.000Z")).toBe("1h 1m");
    expect(formatElapsed("2026-04-09T12:00:00.000Z")).toBe("1d");
    expect(formatElapsed("2026-04-08T07:00:00.000Z")).toBe("2d 5h");

    vi.useRealTimers();
  });

  it("active run with state file shows correct phase and progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");
    const runEntry = makeRunEntry({
      id: "run-active",
      repo: "/repos/active",
      pid: process.pid,
      branch: "feature/dashboard",
      planPath,
      statePath,
      startedAt: "2026-04-10T10:00:00.000Z",
    });

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      currentPhase: "review",
      currentSlice: 2,
      currentGroup: "Dashboard",
      lastCompletedSlice: 1,
      sliceTimings: [
        {
          number: 1,
          startedAt: "2026-04-10T10:00:00.000Z",
          completedAt: "2026-04-10T10:30:00.000Z",
        },
        {
          number: 2,
          startedAt: "2026-04-10T10:30:00.000Z",
        },
      ],
    });
    await writeRegistry(registryPath, [runEntry]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.queued).toEqual([]);
    expect(result.completed).toEqual([]);
    expect(result.active).toHaveLength(1);
    expect(result.active[0]).toMatchObject({
      id: "run-active",
      repo: "/repos/active",
      branch: "feature/dashboard",
      planName: "Dashboard",
      startedAt: "2026-04-10T10:00:00.000Z",
      status: "active",
      sliceProgress: "S1/2",
      currentPhase: "review",
      elapsed: "2h",
      pid: process.pid,
      logPath: join(tempDir, "logs", "state.log"),
    });

    vi.useRealTimers();
  });

  it("active run projects group and slice statuses from plan and state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      currentPhase: "review",
      currentSlice: 2,
      currentGroup: "Dashboard",
      lastCompletedSlice: 1,
      sliceTimings: [
        {
          number: 1,
          startedAt: "2026-04-10T10:00:00.000Z",
          completedAt: "2026-04-10T10:30:00.000Z",
        },
        {
          number: 2,
          startedAt: "2026-04-10T10:30:00.000Z",
        },
      ],
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        planPath,
        statePath,
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active[0]?.groups).toEqual([
      {
        name: "Dashboard",
        slices: [
          { number: 1, title: "Registry", status: "done", elapsed: "30m" },
          { number: 2, title: "Aggregator", status: "active", elapsed: "1h 30m" },
        ],
      },
    ]);

    vi.useRealTimers();
  });

  it("active run elapsed prefers state startedAt over registry startedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T11:00:00.000Z",
      lastCompletedSlice: 1,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-state-started-at-active",
        planPath,
        statePath,
        startedAt: "2026-04-10T08:00:00.000Z",
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active).toHaveLength(1);
    expect(result.active[0]?.startedAt).toBe("2026-04-10T11:00:00.000Z");
    expect(result.active[0]?.elapsed).toBe("1h");

    vi.useRealTimers();
  });

  it("run startedAt falls back to the registry value when state startedAt is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      lastCompletedSlice: 1,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-registry-started-at",
        planPath,
        statePath,
        startedAt: "2026-04-10T09:30:00.000Z",
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active).toHaveLength(1);
    expect(result.active[0]?.startedAt).toBe("2026-04-10T09:30:00.000Z");
    expect(result.active[0]?.elapsed).toBe("2h 30m");

    vi.useRealTimers();
  });

  it("derives logPath from the canonical state file path", async () => {
    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const orchDir = join(tempDir, ".orch");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(orchDir, "state", "plan-abc123.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      lastCompletedSlice: 1,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-random-uuid",
        planPath,
        statePath,
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active[0]?.logPath).toBe(join(orchDir, "logs", "plan-abc123.log"));
  });

  it("dead PID is classified as failed when slices remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      currentPhase: "review",
      currentSlice: 2,
      lastCompletedSlice: 1,
      sliceTimings: [
        {
          number: 1,
          startedAt: "2026-04-10T10:00:00.000Z",
          completedAt: "2026-04-10T10:30:00.000Z",
        },
        {
          number: 2,
          startedAt: "2026-04-10T10:30:00.000Z",
        },
      ],
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-dead",
        pid: 999999,
        planPath,
        statePath,
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active).toEqual([]);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      id: "run-dead",
      status: "failed",
      sliceProgress: "S1/2",
      currentPhase: "review",
      elapsed: "2h",
    });
    expect(result.completed[0]?.groups).toEqual([
      {
        name: "Dashboard",
        slices: [
          { number: 1, title: "Registry", status: "done", elapsed: "30m" },
          { number: 2, title: "Aggregator", status: "failed", elapsed: "1h 30m" },
        ],
      },
    ]);

    vi.useRealTimers();
  });

  it("dead PID is classified as completed when all slices are done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      lastCompletedSlice: 2,
      sliceTimings: [
        {
          number: 1,
          startedAt: "2026-04-10T10:00:00.000Z",
          completedAt: "2026-04-10T10:30:00.000Z",
        },
        {
          number: 2,
          startedAt: "2026-04-10T10:30:00.000Z",
          completedAt: "2026-04-10T11:15:00.000Z",
        },
      ],
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-complete",
        pid: 999999,
        planPath,
        statePath,
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      id: "run-complete",
      status: "completed",
      sliceProgress: "S2/2",
    });
    expect(result.completed[0]?.groups).toEqual([
      {
        name: "Dashboard",
        slices: [
          { number: 1, title: "Registry", status: "done", elapsed: "30m" },
          { number: 2, title: "Aggregator", status: "done", elapsed: "45m" },
        ],
      },
    ]);

    vi.useRealTimers();
  });

  it("completed run elapsed prefers state startedAt over registry startedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T11:00:00.000Z",
      lastCompletedSlice: 2,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-state-started-at-completed",
        pid: 999999,
        planPath,
        statePath,
        startedAt: "2026-04-10T07:00:00.000Z",
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      id: "run-state-started-at-completed",
      status: "completed",
      elapsed: "1h",
    });

    vi.useRealTimers();
  });

  it("dead PID is classified as failed when completed slice count exceeds plan total", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      lastCompletedSlice: 3,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-over-complete",
        pid: 999999,
        planPath,
        statePath,
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      id: "run-over-complete",
      status: "failed",
      sliceProgress: "S3/2",
    });

    vi.useRealTimers();
  });

  it("queued entries are included from queue file", async () => {
    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const first = makeQueueEntry();
    const second = makeQueueEntry({
      id: "queue-2",
      repo: "/repos/queued-two",
      flags: ["--dry-run"],
    });

    await addToQueue(queuePath, first);
    await addToQueue(queuePath, second);

    await expect(aggregateDashboard(registryPath, queuePath)).resolves.toMatchObject({
      active: [],
      completed: [],
      queued: [first, second],
    });
  });

  it("runs are sorted with active oldest first and completed newest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePathA = join(tempDir, "state-a.json");
    const statePathB = join(tempDir, "state-b.json");
    const statePathC = join(tempDir, "state-c.json");
    const statePathD = join(tempDir, "state-d.json");

    await writeJson(planPath, makePlan());
    await Promise.all([
      writeJson(statePathA, { startedAt: "2026-04-10T08:00:00.000Z", lastCompletedSlice: 0 }),
      writeJson(statePathB, { startedAt: "2026-04-10T09:00:00.000Z", lastCompletedSlice: 1 }),
      writeJson(statePathC, { startedAt: "2026-04-10T07:00:00.000Z", lastCompletedSlice: 2 }),
      writeJson(statePathD, { startedAt: "2026-04-10T11:00:00.000Z", lastCompletedSlice: 1 }),
    ]);
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "active-2",
        pid: process.pid,
        planPath,
        statePath: statePathB,
        startedAt: "2026-04-10T09:00:00.000Z",
      }),
      makeRunEntry({
        id: "dead-1",
        pid: 999998,
        planPath,
        statePath: statePathC,
        startedAt: "2026-04-10T07:00:00.000Z",
      }),
      makeRunEntry({
        id: "active-1",
        pid: process.pid,
        planPath,
        statePath: statePathA,
        startedAt: "2026-04-10T08:00:00.000Z",
      }),
      makeRunEntry({
        id: "dead-2",
        pid: 999999,
        planPath,
        statePath: statePathD,
        startedAt: "2026-04-10T11:00:00.000Z",
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active.map((run) => run.id)).toEqual(["active-1", "active-2"]);
    expect(result.completed.map((run) => run.id)).toEqual(["dead-2", "dead-1"]);

    vi.useRealTimers();
  });

  it("completed run is pruned after the first poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      lastCompletedSlice: 2,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-second-poll",
        pid: 999999,
        planPath,
        statePath,
      }),
    ]);

    const firstResult = await aggregateDashboard(registryPath, queuePath);
    const secondResult = await aggregateDashboard(registryPath, queuePath);

    expect(firstResult.completed.map((run) => run.id)).toEqual(["run-second-poll"]);
    expect(secondResult.completed).toEqual([]);

    vi.useRealTimers();
  });

  it("corrupt state file falls back to minimal run info", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeFile(statePath, JSON.stringify({ currentPhase: "broken-phase" }));
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-corrupt-state",
        planPath,
        statePath,
        startedAt: "2026-04-10T10:00:00.000Z",
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active).toHaveLength(1);
    expect(result.active[0]).toMatchObject({
      id: "run-corrupt-state",
      status: "active",
      planName: "Dashboard",
      sliceProgress: "S0/2",
      elapsed: "2h",
      currentPhase: undefined,
    });

    vi.useRealTimers();
  });

  it("does not mark currentSlice as active after currentPhase has cleared", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "plan.json");
    const statePath = join(tempDir, "state.json");

    await writeJson(planPath, makePlan());
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      currentSlice: 2,
      lastCompletedSlice: 1,
      sliceTimings: [
        {
          number: 1,
          startedAt: "2026-04-10T10:00:00.000Z",
          completedAt: "2026-04-10T10:30:00.000Z",
        },
        {
          number: 2,
          startedAt: "2026-04-10T10:30:00.000Z",
        },
      ],
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-phase-cleared",
        planPath,
        statePath,
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active[0]?.groups).toEqual([
      {
        name: "Dashboard",
        slices: [
          { number: 1, title: "Registry", status: "done", elapsed: "30m" },
          { number: 2, title: "Aggregator", status: "pending", elapsed: "1h 30m" },
        ],
      },
    ]);

    vi.useRealTimers();
  });

  it("corrupt plan file falls back to filename stem and omits groups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "broken-plan.json");
    const statePath = join(tempDir, "state.json");

    await writeFile(planPath, "{ definitely-not-json");
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      lastCompletedSlice: 1,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-corrupt-plan",
        planPath,
        statePath,
        startedAt: "2026-04-10T10:00:00.000Z",
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.active).toHaveLength(1);
    expect(result.active[0]).toMatchObject({
      id: "run-corrupt-plan",
      planName: "broken-plan",
      sliceProgress: "S1/0",
      elapsed: "2h",
    });
    expect(result.active[0]?.groups).toBeUndefined();

    vi.useRealTimers();
  });

  it("dead PID with corrupt plan is classified as dead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const registryPath = join(tempDir, "runs.json");
    const queuePath = join(tempDir, "queue.json");
    const planPath = join(tempDir, "broken-plan.json");
    const statePath = join(tempDir, "state.json");

    await writeFile(planPath, "{ definitely-not-json");
    await writeJson(statePath, {
      startedAt: "2026-04-10T10:00:00.000Z",
      lastCompletedSlice: 1,
    });
    await writeRegistry(registryPath, [
      makeRunEntry({
        id: "run-dead-corrupt-plan",
        pid: 999999,
        planPath,
        statePath,
        startedAt: "2026-04-10T10:00:00.000Z",
      }),
    ]);

    const result = await aggregateDashboard(registryPath, queuePath);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      id: "run-dead-corrupt-plan",
      planName: "broken-plan",
      status: "dead",
      sliceProgress: "S1/0",
      elapsed: "2h",
    });
    expect(result.completed[0]?.groups).toBeUndefined();

    vi.useRealTimers();
  });
});
