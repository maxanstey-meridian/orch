import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel, DashboardRun } from "#domain/dashboard.js";
import type { QueueEntry } from "#domain/queue.js";
import { createSupervisor } from "#infrastructure/dashboard/supervisor.js";
import { removeFromQueue } from "#infrastructure/queue/queue-store.js";
import { DashboardApp } from "#ui/dashboard/dashboard-app.js";
import type { DashboardAppProps } from "#ui/dashboard/dashboard-app.js";
import { useDashboardData } from "#ui/dashboard/use-dashboard-data.js";

vi.mock("#ui/dashboard/use-dashboard-data.js", () => ({
  useDashboardData: vi.fn(),
}));

vi.mock("#infrastructure/queue/queue-store.js", () => ({
  removeFromQueue: vi.fn(),
}));

const supervisorState = vi.hoisted(() => ({
  latest: undefined as
    | {
        readonly start: ReturnType<typeof vi.fn>;
        readonly stop: ReturnType<typeof vi.fn>;
      }
    | undefined,
}));

vi.mock("#infrastructure/dashboard/supervisor.js", () => ({
  createSupervisor: vi.fn(() => {
    const supervisor = {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: false,
    };
    supervisorState.latest = supervisor;
    return supervisor;
  }),
}));

const tailViewState = vi.hoisted(() => ({
  latestProps: undefined as
    | { readonly runId: string; readonly logPath?: string; readonly onBack: () => void }
    | undefined,
}));

const queuePromptState = vi.hoisted(() => ({
  latestProps: undefined as
    | { readonly queuePath: string; readonly onDone: () => void; readonly onCancel: () => void }
    | undefined,
}));

vi.mock("#ui/dashboard/tail-view.js", () => ({
  TailView: ({
    runId,
    logPath,
    onBack,
  }: {
    readonly runId: string;
    readonly logPath?: string;
    readonly onBack: () => void;
  }) => {
    tailViewState.latestProps = { runId, logPath, onBack };
    return <Text>{`Tail view: ${runId} ${logPath ?? "-"}`}</Text>;
  },
}));

vi.mock("#ui/dashboard/queue-prompt.js", () => ({
  QueuePrompt: ({
    queuePath,
    onDone,
    onCancel,
  }: {
    readonly queuePath: string;
    readonly onDone: () => void;
    readonly onCancel: () => void;
  }) => {
    queuePromptState.latestProps = { queuePath, onDone, onCancel };
    return <Text>{`Queue prompt: ${queuePath}`}</Text>;
  },
}));

const useDashboardDataMock = vi.mocked(useDashboardData);
const removeFromQueueMock = vi.mocked(removeFromQueue);
const createSupervisorMock = vi.mocked(createSupervisor);
const defaultDashboardAppProps: DashboardAppProps = {
  registryPath: "/tmp/runs.json",
  queuePath: "/tmp/queue.json",
  orchBin: "/tmp/orch-bin.js",
};

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

const makeHookResult = (
  overrides: Partial<ReturnType<typeof useDashboardData>> = {},
): ReturnType<typeof useDashboardData> => ({
  model: makeModel(),
  loading: false,
  error: undefined,
  refresh: vi.fn(),
  ...overrides,
});

const flushEffects = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });

const waitForFrame = async (
  app: { lastFrame: () => string | undefined },
  predicate: (frame: string) => boolean,
  timeoutMs = 500,
): Promise<string> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const frame = app.lastFrame() ?? "";
    if (predicate(frame)) {
      return frame;
    }

    await flushEffects();
  }

  throw new Error(`Timed out waiting for dashboard frame: ${app.lastFrame() ?? ""}`);
};

const renderDashboardApp = (
  overrides: Partial<typeof defaultDashboardAppProps> = {},
) =>
  render(
    <DashboardApp
      {...defaultDashboardAppProps}
      {...overrides}
    />,
  );

describe("DashboardApp", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    tailViewState.latestProps = undefined;
    queuePromptState.latestProps = undefined;
    supervisorState.latest = undefined;
  });

  it("renders a loading state while the dashboard hook is loading", () => {
    useDashboardDataMock.mockReturnValue(makeHookResult({ loading: true }));

    const app = renderDashboardApp();

    expect(app.lastFrame()).toContain("Loading dashboard…");

    app.unmount();
  });

  it("renders an error state when the dashboard hook fails", () => {
    useDashboardDataMock.mockReturnValue(makeHookResult({ error: "boom" }));

    const app = renderDashboardApp();

    expect(app.lastFrame()).toContain("Dashboard error: boom");

    app.unmount();
  });

  it("renders the main dashboard view from the polled model", () => {
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [makeRun({ id: "run-active" })],
        }),
      }),
    );

    const app = renderDashboardApp();

    expect(app.lastFrame()).toContain("Active");
    expect(app.lastFrame()).toContain("run-ac");

    app.unmount();
  });

  it("starts the supervisor on mount and stops it on unmount", () => {
    useDashboardDataMock.mockReturnValue(makeHookResult());

    const app = renderDashboardApp();

    expect(createSupervisorMock).toHaveBeenCalledWith({
      registryPath: "/tmp/runs.json",
      queuePath: "/tmp/queue.json",
      orchBin: "/tmp/orch-bin.js",
    });
    expect(supervisorState.latest?.start).toHaveBeenCalledTimes(1);

    app.unmount();

    expect(supervisorState.latest?.stop).toHaveBeenCalledTimes(1);
  });

  it("does not recreate the supervisor on a rerender with the same paths", () => {
    useDashboardDataMock.mockReturnValue(makeHookResult());

    const app = renderDashboardApp();

    app.rerender(
      <DashboardApp
        {...defaultDashboardAppProps}
      />,
    );

    expect(createSupervisorMock).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("recreates the supervisor when the dashboard paths change", () => {
    useDashboardDataMock.mockReturnValue(makeHookResult());

    const app = renderDashboardApp({
      registryPath: "/tmp/runs-a.json",
      queuePath: "/tmp/queue-a.json",
    });

    const firstSupervisor = supervisorState.latest;

    app.rerender(
      <DashboardApp
        registryPath="/tmp/runs-b.json"
        queuePath="/tmp/queue-b.json"
        orchBin="/tmp/orch-bin.js"
      />,
    );

    expect(firstSupervisor?.stop).toHaveBeenCalledTimes(1);
    expect(createSupervisorMock).toHaveBeenCalledTimes(2);
    expect(createSupervisorMock).toHaveBeenLastCalledWith({
      registryPath: "/tmp/runs-b.json",
      queuePath: "/tmp/queue-b.json",
      orchBin: "/tmp/orch-bin.js",
    });
    expect(supervisorState.latest?.start).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("recreates the supervisor when the orchBin changes", () => {
    useDashboardDataMock.mockReturnValue(makeHookResult());

    const app = renderDashboardApp({
      orchBin: "/tmp/orch-a.js",
    });

    const firstSupervisor = supervisorState.latest;

    app.rerender(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
        orchBin="/tmp/orch-b.js"
      />,
    );

    expect(firstSupervisor?.stop).toHaveBeenCalledTimes(1);
    expect(createSupervisorMock).toHaveBeenCalledTimes(2);
    expect(createSupervisorMock).toHaveBeenLastCalledWith({
      registryPath: "/tmp/runs.json",
      queuePath: "/tmp/queue.json",
      orchBin: "/tmp/orch-b.js",
    });

    app.unmount();
  });

  it("switches to the detail view when enter is pressed on an active run", async () => {
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [makeRun({ id: "run-active" })],
        }),
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("\r");
    await flushEffects();

    expect(app.lastFrame()).toContain("Plan: Dashboard");
    expect(app.lastFrame()).toContain("Registry");

    app.unmount();
  });

  it("switches to the detail view for a completed run", async () => {
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [makeRun({ id: "run-active" })],
          completed: [makeRun({ id: "run-done", status: "completed" })],
        }),
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("\u001B[B");
    await flushEffects();
    app.stdin.write("\r");
    await flushEffects();

    expect(app.lastFrame()).toContain("Plan: Dashboard");
    expect(app.lastFrame()).toContain("Elapsed: 5m");

    app.unmount();
  });

  it("switches to the tail view when f is pressed on a run and routes back to main", async () => {
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [
            makeRun({
              id: "run-active",
              logPath: "/tmp/.orch/logs/plan-abc123.log",
            }),
          ],
        }),
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("f");
    await flushEffects();

    expect(app.lastFrame()).toContain("Tail view: run-active /tmp/.orch/logs/plan-abc123.log");
    expect(tailViewState.latestProps?.logPath).toBe("/tmp/.orch/logs/plan-abc123.log");

    tailViewState.latestProps?.onBack();
    const mainFrame = await waitForFrame(app, (frame) => frame.includes("Active"));

    expect(mainFrame).toContain("run-ac");

    app.unmount();
  });

  it("routes tail from detail and returns to detail", async () => {
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [
            makeRun({
              id: "run-active",
              logPath: "/tmp/.orch/logs/plan-abc123.log",
            }),
          ],
        }),
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("\r");
    await flushEffects();
    await flushEffects();
    expect(app.lastFrame()).toContain("Plan: Dashboard");
    app.stdin.write("f");
    await flushEffects();

    expect(app.lastFrame()).toContain("Tail view: run-active /tmp/.orch/logs/plan-abc123.log");

    tailViewState.latestProps?.onBack();
    const detailFrame = await waitForFrame(app, (frame) => frame.includes("Plan: Dashboard"));

    expect(detailFrame).toContain("Registry");

    app.unmount();
  });

  it("keeps the captured logPath while tail is open after the run disappears from the model", async () => {
    let hookState = makeHookResult({
      model: makeModel({
        active: [
          makeRun({
            id: "run-active",
            logPath: "/tmp/.orch/logs/plan-abc123.log",
          }),
        ],
      }),
    });
    useDashboardDataMock.mockImplementation(() => hookState);

    const app = renderDashboardApp();

    app.stdin.write("f");
    await flushEffects();

    expect(app.lastFrame()).toContain("Tail view: run-active /tmp/.orch/logs/plan-abc123.log");

    hookState = makeHookResult({
      model: makeModel(),
      refresh: hookState.refresh,
    });
    app.rerender(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
        orchBin="/tmp/orch-bin.js"
      />,
    );
    await flushEffects();

    expect(app.lastFrame()).toContain("Tail view: run-active /tmp/.orch/logs/plan-abc123.log");
    expect(tailViewState.latestProps?.logPath).toBe("/tmp/.orch/logs/plan-abc123.log");

    app.unmount();
  });

  it("shows a run ended message and returns to the main view when the selected run disappears", async () => {
    vi.useFakeTimers();
    let hookState = makeHookResult({
      model: makeModel({
        active: [makeRun({ id: "run-active" })],
      }),
    });
    useDashboardDataMock.mockImplementation(() => hookState);

    const app = renderDashboardApp();

    app.stdin.write("\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.lastFrame()).toContain("Plan: Dashboard");

    hookState = makeHookResult({
      model: makeModel(),
      refresh: hookState.refresh,
    });
    app.rerender(
      <DashboardApp
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
        orchBin="/tmp/orch-bin.js"
      />,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(app.lastFrame()).toContain("Run ended");

    await vi.advanceTimersByTimeAsync(1499);

    expect(app.lastFrame()).toContain("Run ended");

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(app.lastFrame()).toContain("Active");
    expect(app.lastFrame()).not.toContain("Run ended");

    app.unmount();
  });

  it("returns to the main view when kill finds the run already exited", async () => {
    const killError = Object.assign(new Error("missing process"), {
      code: "ESRCH",
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw killError;
    });
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [makeRun({ id: "run-active" })],
        }),
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("\r");
    await flushEffects();
    await flushEffects();
    expect(app.lastFrame()).toContain("Plan: Dashboard");

    app.stdin.write("k");
    await flushEffects();

    expect(killSpy).toHaveBeenCalledWith(123, "SIGTERM");
    expect(app.lastFrame()).toContain("Active");
    expect(app.lastFrame()).not.toContain("Plan: Dashboard");

    app.unmount();
  });

  it("keeps a deleted queued row hidden and removes it from the queue store", async () => {
    removeFromQueueMock.mockResolvedValue(undefined);
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          queued: [makeQueueEntry({ id: "queue-entry-456" })],
        }),
      }),
    );

    const app = renderDashboardApp();

    expect(app.lastFrame()).toContain("> ○ queue-");

    app.stdin.write("d");
    await flushEffects();

    expect(removeFromQueueMock).toHaveBeenCalledWith("/tmp/queue.json", "queue-entry-456");
    expect(app.lastFrame()).not.toContain("queue-");

    app.unmount();
  });

  it("keeps a deleted completed row hidden without touching the queue store", async () => {
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [makeRun({ id: "run-active" })],
          completed: [makeRun({ id: "run-done-789", status: "completed" })],
        }),
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-do");

    app.stdin.write("d");
    await flushEffects();

    expect(removeFromQueueMock).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain("run-do");

    app.unmount();
  });

  it("opens the queue prompt from q and returns to main on cancel", async () => {
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [makeRun({ id: "run-active" })],
        }),
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("q");
    await flushEffects();

    expect(app.lastFrame()).toContain("Queue prompt: /tmp/queue.json");

    queuePromptState.latestProps?.onCancel();
    const mainFrame = await waitForFrame(app, (frame) => frame.includes("Active"));

    expect(mainFrame).toContain("run-ac");

    app.unmount();
  });

  it("refreshes dashboard data after queue prompt completion", async () => {
    const refresh = vi.fn();
    useDashboardDataMock.mockReturnValue(
      makeHookResult({
        model: makeModel({
          active: [makeRun({ id: "run-active" })],
        }),
        refresh,
      }),
    );

    const app = renderDashboardApp();

    app.stdin.write("q");
    await flushEffects();
    queuePromptState.latestProps?.onDone();
    await flushEffects();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain("Active");

    app.unmount();
  });
});
