import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel } from "#domain/dashboard.js";
import { aggregateDashboard } from "#infrastructure/dashboard/data-aggregator.js";
import { useDashboardData } from "#ui/dashboard/use-dashboard-data.js";

vi.mock("#infrastructure/dashboard/data-aggregator.js", () => ({
  aggregateDashboard: vi.fn(),
}));

const aggregateDashboardMock = vi.mocked(aggregateDashboard);

const emptyModel: DashboardModel = {
  active: [],
  queued: [],
  completed: [],
};

const createDeferred = <T,>() => {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
};

const flushEffects = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });

const waitForFrame = async (
  getFrame: () => string,
  matcher: (frame: string) => boolean,
  timeoutMs = 1_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = getFrame();
    if (matcher(frame)) {
      return frame;
    }

    await flushEffects();
  }

  return getFrame();
};

const HookProbe = ({
  registryPath,
  queuePath,
  intervalMs,
}: {
  registryPath: string;
  queuePath: string;
  intervalMs?: number;
}) => {
  const { model, loading, error } = useDashboardData(registryPath, queuePath, intervalMs);

  return <Text>{JSON.stringify({ model, loading, error })}</Text>;
};

const RefreshProbe = ({
  registryPath,
  queuePath,
  onRefreshReady,
}: {
  registryPath: string;
  queuePath: string;
  onRefreshReady: (refresh: () => void) => void;
}) => {
  const { model, loading, error, refresh } = useDashboardData(registryPath, queuePath);

  useEffect(() => {
    onRefreshReady(refresh);
  }, [onRefreshReady, refresh]);

  return <Text>{JSON.stringify({ model, loading, error })}</Text>;
};

describe("useDashboardData", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("loads dashboard data immediately on mount", async () => {
    aggregateDashboardMock.mockResolvedValueOnce({
      active: [
        {
          id: "run-1",
          repo: "/repos/orch",
          status: "active",
          sliceProgress: "S1/3",
          elapsed: "5m",
          pid: 123,
        },
      ],
      queued: [],
      completed: [],
    });

    const app = render(
      <HookProbe
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    await flushEffects();

    expect(aggregateDashboardMock).toHaveBeenCalledWith("/tmp/runs.json", "/tmp/queue.json");
    expect(app.lastFrame()).toContain('"loading":false');
    expect(app.lastFrame()).toContain('"id":"run-1"');
    expect(app.lastFrame()).not.toContain('"error"');

    app.unmount();
  });

  it("refreshes dashboard data on the polling interval", async () => {
    vi.useFakeTimers();
    aggregateDashboardMock
      .mockResolvedValueOnce(emptyModel)
      .mockResolvedValueOnce({
        active: [
          {
            id: "run-2",
            repo: "/repos/orch",
            status: "active",
            sliceProgress: "S2/3",
            elapsed: "9m",
            pid: 456,
          },
        ],
        queued: [],
        completed: [],
      });

    const app = render(
      <HookProbe
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
        intervalMs={5_000}
      />,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(aggregateDashboardMock).toHaveBeenCalledTimes(2);
    expect(app.lastFrame()).toContain('"id":"run-2"');

    app.unmount();
  });

  it("uses a 2000ms default polling interval", async () => {
    vi.useFakeTimers();
    aggregateDashboardMock.mockResolvedValue(emptyModel);

    const app = render(
      <HookProbe
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
      />,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(aggregateDashboardMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(aggregateDashboardMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(aggregateDashboardMock).toHaveBeenCalledTimes(2);

    app.unmount();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    aggregateDashboardMock.mockResolvedValue(emptyModel);

    const app = render(
      <HookProbe
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
        intervalMs={5_000}
      />,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(aggregateDashboardMock).toHaveBeenCalledTimes(1);

    app.unmount();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(aggregateDashboardMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the most recent poll result when an older request resolves late", async () => {
    vi.useFakeTimers();
    const initialLoad = createDeferred<DashboardModel>();
    const refreshedLoad = createDeferred<DashboardModel>();

    aggregateDashboardMock
      .mockImplementationOnce(() => initialLoad.promise)
      .mockImplementationOnce(() => refreshedLoad.promise);

    const app = render(
      <HookProbe
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
        intervalMs={5_000}
      />,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    refreshedLoad.resolve({
      active: [
        {
          id: "run-new",
          repo: "/repos/new",
          status: "active",
          sliceProgress: "S2/3",
          elapsed: "3m",
          pid: 999,
        },
      ],
      queued: [],
      completed: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    initialLoad.resolve({
      active: [
        {
          id: "run-old",
          repo: "/repos/old",
          status: "active",
          sliceProgress: "S1/3",
          elapsed: "10m",
          pid: 111,
        },
      ],
      queued: [],
      completed: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(app.lastFrame()).toContain('"id":"run-new"');
    expect(app.lastFrame()).not.toContain('"id":"run-old"');

    app.unmount();
  });

  it("refreshes immediately when refresh is called", async () => {
    aggregateDashboardMock
      .mockResolvedValueOnce(emptyModel)
      .mockResolvedValueOnce({
        active: [
          {
            id: "run-refresh",
            repo: "/repos/orch",
            status: "active",
            sliceProgress: "S3/3",
            elapsed: "12m",
            pid: 789,
          },
        ],
        queued: [],
        completed: [],
      });

    let refreshDashboard!: () => void;
    const app = render(
      <RefreshProbe
        registryPath="/tmp/runs.json"
        queuePath="/tmp/queue.json"
        onRefreshReady={(refresh) => {
          refreshDashboard = refresh;
        }}
      />,
    );

    await flushEffects();
    refreshDashboard();
    const finalFrame = await waitForFrame(
      () => app.lastFrame() ?? "",
      (frame) => frame.includes('"id":"run-refresh"'),
    );

    expect(aggregateDashboardMock).toHaveBeenCalledTimes(2);
    expect(finalFrame).toContain('"id":"run-refresh"');

    app.unmount();
  });
});
