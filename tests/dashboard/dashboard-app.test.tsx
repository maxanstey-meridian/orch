import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel, DashboardRun } from "#domain/dashboard.js";
import type { QueueEntry } from "#domain/queue.js";
import { removeFromQueue } from "#infrastructure/queue/queue-store.js";
import { DashboardApp } from "#ui/dashboard/dashboard-app.js";
import { useDashboardData } from "#ui/dashboard/use-dashboard-data.js";

vi.mock("#ui/dashboard/use-dashboard-data.js", () => ({
  useDashboardData: vi.fn(),
}));

vi.mock("#infrastructure/queue/queue-store.js", () => ({
  removeFromQueue: vi.fn(),
}));

const useDashboardDataMock = vi.mocked(useDashboardData);
const removeFromQueueMock = vi.mocked(removeFromQueue);

const makeRun = (overrides: Partial<DashboardRun> = {}): DashboardRun => ({
  id: "run-1",
  repo: "/repos/orch",
  branch: "feature/dashboard",
  planName: "Dashboard",
  startedAt: "2026-04-10T10:00:00.000Z",
  status: "active",
  sliceProgress: "S1/3",
  currentPhase: "review",
  elapsed: "5m",
  pid: 123,
  groups: [
    {
      name: "Foundation",
      slices: [
        { number: 1, title: "Registry", status: "done", elapsed: "10m" },
        { number: 2, title: "Aggregator", status: "active", elapsed: "5m" },
      ],
    },
  ],
  ...overrides,
});

const makeModel = (overrides: Partial<DashboardModel> = {}): DashboardModel => ({
  active: [],
  queued: [],
  completed: [],
  ...overrides,
});

const makeQueueEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: "queue-1",
  repo: "/repos/orch",
  branch: "feature/queued",
  planPath: "/plans/dashboard.json",
  flags: ["--auto"],
  addedAt: "2026-04-10T10:00:00.000Z",
  ...overrides,
});

const flushEffects = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });

describe("DashboardApp", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a loading state while the dashboard hook is loading", () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel(),
      loading: true,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    expect(app.lastFrame()).toContain("Loading dashboard…");

    app.unmount();
  });

  it("renders an error state when the dashboard hook fails", () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel(),
      loading: false,
      error: "boom",
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    expect(app.lastFrame()).toContain("Dashboard error: boom");

    app.unmount();
  });

  it("renders the main dashboard view from the polled model", () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
      }),
      loading: false,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    expect(app.lastFrame()).toContain("Active");
    expect(app.lastFrame()).toContain("run-ac");

    app.unmount();
  });

  it("switches to the detail view when enter is pressed on an active run", async () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
      }),
      loading: false,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    app.stdin.write("\r");
    await flushEffects();

    expect(app.lastFrame()).toContain("Plan: Dashboard");
    expect(app.lastFrame()).toContain("Registry");

    app.unmount();
  });

  it("switches to the detail view for a completed run", async () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
        completed: [makeRun({ id: "run-done", status: "completed" })],
      }),
      loading: false,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    app.stdin.write("\u001B[B");
    await flushEffects();
    app.stdin.write("\r");
    await flushEffects();

    expect(app.lastFrame()).toContain("Plan: Dashboard");
    expect(app.lastFrame()).toContain("Elapsed: 5m");

    app.unmount();
  });

  it("switches to the tail placeholder when f is pressed on a run", async () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
      }),
      loading: false,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    app.stdin.write("f");
    await flushEffects();

    expect(app.lastFrame()).toContain("Tail placeholder: run-active");

    app.unmount();
  });

  it("routes tail from detail with returnTo detail", async () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
      }),
      loading: false,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    app.stdin.write("\r");
    await flushEffects();
    await flushEffects();
    expect(app.lastFrame()).toContain("Plan: Dashboard");
    app.stdin.write("f");
    await flushEffects();

    expect(app.lastFrame()).toContain("Tail placeholder: run-active");
    expect(app.lastFrame()).toContain("Return to: detail");

    app.unmount();
  });

  it("shows a run ended message and returns to the main view when the selected run disappears", async () => {
    let hookState = {
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
      }),
      loading: false,
      error: undefined as string | undefined,
    };
    useDashboardDataMock.mockImplementation(() => hookState);

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    app.stdin.write("\r");
    await flushEffects();
    expect(app.lastFrame()).toContain("Plan: Dashboard");

    hookState = {
      model: makeModel(),
      loading: false,
      error: undefined,
    };
    app.rerender(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    expect(app.lastFrame()).toContain("Run ended");

    await flushEffects();
    await flushEffects();

    expect(app.lastFrame()).toContain("Active");
    expect(app.lastFrame()).not.toContain("Run ended");

    app.unmount();
  });

  it("keeps a deleted queued row hidden and removes it from the queue store", async () => {
    removeFromQueueMock.mockResolvedValue(undefined);
    useDashboardDataMock.mockReturnValue({
      model: makeModel({
        queued: [makeQueueEntry({ id: "queue-entry-456" })],
      }),
      loading: false,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    expect(app.lastFrame()).toContain("> ○ queue-");

    app.stdin.write("d");
    await flushEffects();

    expect(removeFromQueueMock).toHaveBeenCalledWith("/tmp/queue.json", "queue-entry-456");
    expect(app.lastFrame()).not.toContain("queue-");

    app.unmount();
  });

  it("keeps a deleted completed row hidden without touching the queue store", async () => {
    useDashboardDataMock.mockReturnValue({
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
        completed: [makeRun({ id: "run-done-789", status: "completed" })],
      }),
      loading: false,
      error: undefined,
    });

    const app = render(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-do");

    app.stdin.write("d");
    await flushEffects();

    expect(removeFromQueueMock).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain("run-do");

    app.unmount();
  });
});
