import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardModel, DashboardRun } from "#domain/dashboard.js";
import type { QueueEntry } from "#domain/queue.js";
import { MainView } from "#ui/dashboard/main-view.js";

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

const makeQueueEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: "queue-1",
  repo: "/repos/orch",
  branch: "feature/queued",
  planPath: "/plans/dashboard.json",
  flags: ["--auto"],
  addedAt: "2026-04-10T10:00:00.000Z",
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

describe("MainView", () => {
  it("renders the empty dashboard frame when there are no rows", () => {
    const app = render(
      <MainView
        model={makeModel()}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("Active");
    expect(app.lastFrame()).toContain("Queued");
    expect(app.lastFrame()).toContain("Completed");
    expect(app.lastFrame()).toContain("No runs to display");

    app.unmount();
  });

  it("renders active, queued, and completed rows in section order", () => {
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active", repo: "/repos/active" })],
          queued: [makeQueueEntry({ id: "queue-1", repo: "/repos/queued" })],
          completed: [makeRun({ id: "run-done", repo: "/repos/completed", status: "completed" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame).toMatch(/Active[\s\S]*run-active[\s\S]*Queued[\s\S]*queue-1[\s\S]*Completed[\s\S]*run-done/);
    expect(frame).toContain("active");
    expect(frame).toContain("queued");
    expect(frame).toContain("completed");
    expect(frame).toContain("feature/dashboard");
    expect(frame).toContain("feature/queued");
    expect(frame).toContain("S1/3");
    expect(frame).toContain("review");
    expect(frame).toContain("5m");

    app.unmount();
  });

  it("moves the selection down through rows and clamps at the end", async () => {
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
          queued: [makeQueueEntry({ id: "queue-1" })],
          completed: [makeRun({ id: "run-done", status: "completed" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("> ● run-active");

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ○ queue-1");

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-done");

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-done");

    app.unmount();
  });

  it("opens detail for the selected run when enter is pressed", async () => {
    const onOpenDetail = vi.fn();
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
          queued: [makeQueueEntry({ id: "queue-1" })],
        })}
        onOpenDetail={onOpenDetail}
        onOpenTail={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    app.stdin.write("\r");
    await flushEffects();

    expect(onOpenDetail).toHaveBeenCalledWith("run-active");

    app.unmount();
  });

  it("opens the selected run tail when f is pressed", async () => {
    const onOpenTail = vi.fn();
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={onOpenTail}
        onKill={vi.fn()}
      />,
    );

    app.stdin.write("f");
    await flushEffects();

    expect(onOpenTail).toHaveBeenCalledWith("run-active");

    app.unmount();
  });

  it("kills the selected run when k is pressed and the row has a pid", async () => {
    const onKill = vi.fn();
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active", pid: 321 })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onKill={onKill}
      />,
    );

    app.stdin.write("k");
    await flushEffects();

    expect(onKill).toHaveBeenCalledWith("run-active");

    app.unmount();
  });

  it("renders only the shortcuts that apply to the selected row", async () => {
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active", pid: 321 })],
          queued: [makeQueueEntry({ id: "queue-1" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("Keys: arrows move");
    expect(app.lastFrame()).toContain("enter detail");
    expect(app.lastFrame()).toContain("f tail");
    expect(app.lastFrame()).toContain("k kill");
    expect(app.lastFrame()).not.toContain("q queue");
    expect(app.lastFrame()).not.toContain("? help");

    app.stdin.write("\u001B[B");
    await flushEffects();

    expect(app.lastFrame()).toContain("Keys: arrows move");
    expect(app.lastFrame()).not.toContain("enter detail");
    expect(app.lastFrame()).not.toContain("f tail");
    expect(app.lastFrame()).not.toContain("k kill");

    app.unmount();
  });
});
