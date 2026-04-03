import { homedir } from "os";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the empty dashboard frame when there are no rows", () => {
    const app = render(
      <MainView
        model={makeModel()}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("Active");
    expect(app.lastFrame()).toContain("Queued");
    expect(app.lastFrame()).toContain("Completed");
    expect(app.lastFrame()).toContain("No runs to display");
    expect((app.lastFrame() ?? "").match(/No runs to display/g)?.length).toBe(3);

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
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame).toMatch(/Active[\s\S]*run-ac[\s\S]*Queued[\s\S]*queue-[\s\S]*Completed[\s\S]*run-do/);
    expect(frame).toContain("●");
    expect(frame).toContain("○");
    expect(frame).toContain("✓");
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
      />,
    );

    expect(app.lastFrame()).toContain("> ● run-ac");

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ○ queue-");

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-do");

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-do");

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
      />,
    );

    app.stdin.write("f");
    await flushEffects();

    expect(onOpenTail).toHaveBeenCalledWith("run-active");

    app.unmount();
  });

  it("kills the selected run when k is pressed and the row has a pid", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active", pid: 321 })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
      />,
    );

    app.stdin.write("k");
    await flushEffects();

    expect(killSpy).toHaveBeenCalledWith(321, "SIGTERM");

    app.unmount();
  });

  it("dismisses a completed run from the main list when k is pressed", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const onDelete = vi.fn();
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
          completed: [makeRun({ id: "run-done", status: "completed", pid: 321 })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onDelete={onDelete}
      />,
    );

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-do");

    app.stdin.write("k");
    await flushEffects();

    expect(killSpy).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith("run-done");

    app.unmount();
  });

  it("keeps the dashboard stable when killing an active run races with process exit", async () => {
    const killError = Object.assign(new Error("missing process"), {
      code: "ESRCH",
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw killError;
    });
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active", pid: 321 })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
      />,
    );

    app.stdin.write("k");
    await flushEffects();

    expect(killSpy).toHaveBeenCalledWith(321, "SIGTERM");
    expect(app.lastFrame()).toContain("> ● run-ac");

    app.unmount();
  });

  it("keeps the fixed key hint row visible while selection moves", async () => {
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active", pid: 321 })],
          queued: [makeQueueEntry({ id: "queue-1" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("↑↓ navigate  ⏎ detail  f tail  q queue  k kill");

    app.stdin.write("\u001B[B");
    await flushEffects();

    expect(app.lastFrame()).toContain("↑↓ navigate  ⏎ detail  f tail  q queue  k kill");

    app.unmount();
  });

  it("ignores run-only shortcuts when the selected row is queued", async () => {
    const onOpenDetail = vi.fn();
    const onOpenTail = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
          queued: [makeQueueEntry({ id: "queue-1" })],
        })}
        onOpenDetail={onOpenDetail}
        onOpenTail={onOpenTail}
      />,
    );

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ○ queue-");

    app.stdin.write("\r");
    app.stdin.write("f");
    app.stdin.write("k");
    await flushEffects();

    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(onOpenTail).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("> ○ queue-");

    app.unmount();
  });

  it("renders the fixed key hint row from the slice contract", () => {
    const app = render(
      <MainView
        model={makeModel({
          active: [
            makeRun({
              id: "run-active",
              repo: `${homedir()}/repos/orch`,
            }),
          ],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("↑↓ navigate  ⏎ detail  f tail  q queue  k kill");

    app.unmount();
  });

  it("renders rows with 6-char ids and home-relative repo columns", () => {
    const app = render(
      <MainView
        model={makeModel({
          active: [
            makeRun({
              id: "run-active-123",
              repo: `${homedir()}/repos/active`,
              branch: "feature/dashboard",
            }),
          ],
          queued: [
            makeQueueEntry({
              id: "queue-entry-456",
              repo: `${homedir()}/repos/queued`,
              branch: undefined,
              planPath: "/plans/queued-plan.json",
            }),
          ],
          completed: [
            makeRun({
              id: "run-done-789",
              repo: `${homedir()}/repos/completed`,
              branch: undefined,
              planName: "Completed Plan",
              status: "completed",
              currentPhase: undefined,
            }),
          ],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("run-ac ~/repos/active feature/dashboard S1/3 review 5m");
    expect(frame).toContain("queue- ~/repos/queued queued-plan - - -");
    expect(frame).toContain("run-do ~/repos/completed Completed Plan S1/3 - 5m");

    app.unmount();
  });

  it("sends SIGTERM to the selected run pid when k is pressed", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active", pid: 321 })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
      />,
    );

    app.stdin.write("k");
    await flushEffects();

    expect(killSpy).toHaveBeenCalledWith(321, "SIGTERM");

    app.unmount();
  });

  it("invokes deletion for the selected queued row when d is pressed", async () => {
    const onDelete = vi.fn();
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
          queued: [makeQueueEntry({ id: "queue-entry-456" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onDelete={onDelete}
      />,
    );

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ○ queue-");

    app.stdin.write("d");
    await flushEffects();

    expect(onDelete).toHaveBeenCalledWith("queue-entry-456");

    app.unmount();
  });

  it("invokes deletion for the selected completed row when d is pressed", async () => {
    const onDelete = vi.fn();
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
          completed: [makeRun({ id: "run-done-789", status: "completed" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onDelete={onDelete}
      />,
    );

    app.stdin.write("\u001B[B");
    await flushEffects();
    expect(app.lastFrame()).toContain("> ✓ run-do");

    app.stdin.write("d");
    await flushEffects();

    expect(onDelete).toHaveBeenCalledWith("run-done-789");

    app.unmount();
  });

  it("does not invoke deletion for the selected active row when d is pressed", async () => {
    const onDelete = vi.fn();
    const app = render(
      <MainView
        model={makeModel({
          active: [makeRun({ id: "run-active" })],
        })}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onDelete={onDelete}
      />,
    );

    app.stdin.write("d");
    await flushEffects();

    expect(onDelete).not.toHaveBeenCalled();

    app.unmount();
  });

  it("opens the queue prompt when q is pressed, even with no rows selected", async () => {
    const onOpenQueue = vi.fn();
    const app = render(
      <MainView
        model={makeModel()}
        onOpenDetail={vi.fn()}
        onOpenTail={vi.fn()}
        onOpenQueue={onOpenQueue}
      />,
    );

    app.stdin.write("q");
    await flushEffects();

    expect(onOpenQueue).toHaveBeenCalledTimes(1);

    app.unmount();
  });
});
