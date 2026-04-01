import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel, DashboardRun } from "#domain/dashboard.js";
import { DashboardApp } from "#ui/dashboard/dashboard-app.js";
import { useDashboardData } from "#ui/dashboard/use-dashboard-data.js";

vi.mock("#ui/dashboard/use-dashboard-data.js", () => ({
  useDashboardData: vi.fn(),
}));

const useDashboardDataMock = vi.mocked(useDashboardData);

const makeRun = (overrides: Partial<DashboardRun> = {}): DashboardRun => ({
  id: "run-1",
  repo: "/repos/orch",
  branch: "feature/dashboard",
  planName: "Dashboard",
  status: "active",
  sliceProgress: "S1/3",
  currentPhase: "review",
  elapsed: "5m",
  pid: 123,
  ...overrides,
});

const makeModel = (overrides: Partial<DashboardModel> = {}): DashboardModel => ({
  active: [],
  queued: [],
  completed: [],
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
    expect(app.lastFrame()).toContain("run-active");

    app.unmount();
  });

  it("switches to the detail placeholder when enter is pressed on a run", async () => {
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

    expect(app.lastFrame()).toContain("Detail placeholder: run-active");

    app.unmount();
  });
});
