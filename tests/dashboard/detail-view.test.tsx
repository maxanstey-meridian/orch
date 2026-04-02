import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardRun } from "#domain/dashboard.js";
import { DetailView } from "#ui/dashboard/detail-view.js";

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
        { number: 3, title: "Queue", status: "pending" },
        { number: 4, title: "Cleanup", status: "failed", elapsed: "2m" },
      ],
    },
  ],
  ...overrides,
});

const flushEffects = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });

describe("DetailView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the run header, groups, slice titles, and elapsed values", () => {
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={vi.fn()}
        onTail={vi.fn()}
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Plan: Dashboard");
    expect(frame).toContain("Branch: feature/dashboard");
    expect(frame).toContain("Started: 2026-04-10T10:00:00.000Z");
    expect(frame).toContain("Elapsed: 5m");
    expect(frame).toContain("Foundation");
    expect(frame).toContain("Registry");
    expect(frame).toContain("Aggregator");
    expect(frame).toContain("10m");
    expect(frame).toContain("←/Esc back");
    expect(frame).toContain("f tail");

    app.unmount();
  });

  it("renders a check mark for done slices", () => {
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={vi.fn()}
        onTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("✓ S1 Registry");

    app.unmount();
  });

  it("renders a play marker for active slices", () => {
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={vi.fn()}
        onTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("▶ S2 Aggregator");

    app.unmount();
  });

  it("renders a circle for pending slices", () => {
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={vi.fn()}
        onTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("○ S3 Queue");

    app.unmount();
  });

  it("renders a cross for failed slices", () => {
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={vi.fn()}
        onTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("✗ S4 Cleanup");

    app.unmount();
  });

  it("renders a fallback message when plan groups are unavailable", () => {
    const app = render(
      <DetailView
        run={makeRun({ groups: undefined })}
        onBack={vi.fn()}
        onTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("No plan details available");

    app.unmount();
  });

  it("returns to the previous view when escape is pressed", async () => {
    const onBack = vi.fn();
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={onBack}
        onTail={vi.fn()}
      />,
    );

    app.stdin.write("\u001B");
    await flushEffects();

    expect(onBack).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("returns to the previous view when left arrow is pressed", async () => {
    const onBack = vi.fn();
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={onBack}
        onTail={vi.fn()}
      />,
    );

    app.stdin.write("\u001B[D");
    await flushEffects();

    expect(onBack).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("opens tail when f is pressed", async () => {
    const onTail = vi.fn();
    const app = render(
      <DetailView
        run={makeRun()}
        onBack={vi.fn()}
        onTail={onTail}
      />,
    );

    app.stdin.write("f");
    await flushEffects();

    expect(onTail).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("sends SIGTERM to the run pid when k is pressed", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const app = render(
      <DetailView
        run={makeRun({ pid: 321 })}
        onBack={vi.fn()}
        onTail={vi.fn()}
      />,
    );

    app.stdin.write("k");
    await flushEffects();

    expect(killSpy).toHaveBeenCalledWith(321, "SIGTERM");

    app.unmount();
  });

  it("dismisses completed runs when k is pressed", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const onDelete = vi.fn();
    const onBack = vi.fn();
    const app = render(
      <DetailView
        run={makeRun({ status: "completed", pid: 321 })}
        onBack={onBack}
        onTail={vi.fn()}
        onDelete={onDelete}
      />,
    );

    app.stdin.write("k");
    await flushEffects();

    expect(killSpy).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith("run-1");
    expect(onBack).toHaveBeenCalledTimes(1);

    app.unmount();
  });
});
