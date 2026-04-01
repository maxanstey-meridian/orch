import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TailView } from "#ui/dashboard/tail-view.js";
import { useLogTail } from "#ui/dashboard/use-log-tail.js";

vi.mock("#ui/dashboard/use-log-tail.js", () => ({
  useLogTail: vi.fn(),
}));

const useLogTailMock = vi.mocked(useLogTail);

const flushEffects = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });

describe("TailView", () => {
  const originalRows = process.stdout.rows;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: 6,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: originalRows,
    });
    vi.clearAllMocks();
  });

  it("renders the latest visible log lines", () => {
    useLogTailMock.mockReturnValue({
      lines: ["line 1", "line 2", "line 3", "line 4", "line 5"],
      error: undefined,
    });

    const app = render(
      <TailView
        runId="run-1"
        logPath="/tmp/.orch/logs/plan-abc123.log"
        onBack={vi.fn()}
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Tail: run-1");
    expect(frame).toContain("line 4");
    expect(frame).toContain("line 5");
    expect(frame).not.toContain("line 3");
    expect(frame).not.toContain("line 1");
    expect(frame).toContain("←/Esc back");

    app.unmount();
  });

  it("returns to the previous view when escape is pressed", async () => {
    const onBack = vi.fn();
    useLogTailMock.mockReturnValue({
      lines: ["line 1"],
      error: undefined,
    });

    const app = render(
      <TailView
        runId="run-1"
        logPath="/tmp/.orch/logs/plan-abc123.log"
        onBack={onBack}
      />,
    );

    app.stdin.write("\u001B");
    await flushEffects();

    expect(onBack).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("returns to the previous view when left arrow is pressed", async () => {
    const onBack = vi.fn();
    useLogTailMock.mockReturnValue({
      lines: ["line 1"],
      error: undefined,
    });

    const app = render(
      <TailView
        runId="run-1"
        logPath="/tmp/.orch/logs/plan-abc123.log"
        onBack={onBack}
      />,
    );

    app.stdin.write("\u001B[D");
    await flushEffects();

    expect(onBack).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("shows the missing-log state when the hook reports an error", () => {
    useLogTailMock.mockReturnValue({
      lines: [],
      error: "Log file not found yet",
    });

    const app = render(
      <TailView
        runId="run-1"
        logPath="/tmp/.orch/logs/plan-abc123.log"
        onBack={vi.fn()}
      />,
    );

    expect(app.lastFrame()).toContain("Log file not found yet");

    app.unmount();
  });
});
