import { resolve } from "path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuePrompt } from "#ui/dashboard/queue-prompt.js";

const flushEffects = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });

const typeText = async (
  app: { stdin: { write: (value: string) => void } },
  value: string,
): Promise<void> => {
  for (const character of value) {
    app.stdin.write(character);
  }

  await flushEffects();
};

describe("QueuePrompt", () => {
  // MANUAL TEST REQUIRED: verify multi-field keyboard navigation through Repo/Plan/Branch/Flags
  // in a real terminal, including branch entry and space-separated flags normalization.
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders input fields with defaults", () => {
    const app = render(
      <QueuePrompt
        queuePath="/tmp/queue.json"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Queue plan");
    expect(frame).toContain(`Repo: ${process.cwd()}`);
    expect(frame).toContain("Plan:");
    expect(frame).toContain("Branch:");
    expect(frame).toContain("Flags: --auto");

    app.unmount();
  });

  it("submitting with a plan path adds a queue entry", async () => {
    const addToQueue = vi.fn().mockResolvedValue(undefined);
    const onDone = vi.fn();
    const app = render(
      <QueuePrompt
        queuePath="/tmp/queue.json"
        onDone={onDone}
        onCancel={vi.fn()}
        addToQueueFn={addToQueue}
        createId={() => "queue-id"}
        now={() => "2026-04-10T10:00:00.000Z"}
      />,
    );

    await typeText(app, "plans/demo.json");
    expect(app.lastFrame()).toContain("Plan: plans/demo.json");
    app.stdin.write("\r");
    await flushEffects();
    await flushEffects();

    expect(addToQueue).toHaveBeenCalledWith(
      "/tmp/queue.json",
      expect.objectContaining({
        repo: resolve(process.cwd()),
        planPath: resolve("plans/demo.json"),
        flags: ["--auto"],
        addedAt: "2026-04-10T10:00:00.000Z",
        id: "queue-id",
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("enforces --auto even when the flags field is cleared before submit", async () => {
    const addToQueue = vi.fn().mockResolvedValue(undefined);
    const onDone = vi.fn();
    const app = render(
      <QueuePrompt
        queuePath="/tmp/queue.json"
        onDone={onDone}
        onCancel={vi.fn()}
        addToQueueFn={addToQueue}
        createId={() => "queue-id"}
        now={() => "2026-04-10T10:00:00.000Z"}
      />,
    );

    app.stdin.write("\t");
    await flushEffects();
    app.stdin.write("\t");
    await flushEffects();
    app.stdin.write("\t");
    await flushEffects();
    for (let index = 0; index < "--auto".length; index += 1) {
      app.stdin.write("\u007F");
    }
    await flushEffects();
    await typeText(app, "plans/demo.json");
    app.stdin.write("\u001B[A");
    await flushEffects();
    app.stdin.write("\u001B[A");
    await flushEffects();
    app.stdin.write("\u001B[A");
    await flushEffects();
    app.stdin.write("\r");
    await flushEffects();
    await flushEffects();

    expect(addToQueue).toHaveBeenCalledWith(
      "/tmp/queue.json",
      expect.objectContaining({
        planPath: resolve("plans/demo.json"),
        flags: ["--auto"],
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it("Esc triggers onCancel without adding to the queue", async () => {
    const onCancel = vi.fn();
    const app = render(
      <QueuePrompt
        queuePath="/tmp/queue.json"
        onDone={vi.fn()}
        onCancel={onCancel}
        addToQueueFn={vi.fn()}
      />,
    );

    app.stdin.write("\u001B");
    await flushEffects();

    expect(onCancel).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("left arrow triggers onCancel without adding to the queue", async () => {
    const onCancel = vi.fn();
    const app = render(
      <QueuePrompt
        queuePath="/tmp/queue.json"
        onDone={vi.fn()}
        onCancel={onCancel}
        addToQueueFn={vi.fn()}
      />,
    );

    app.stdin.write("\u001B[D");
    await flushEffects();

    expect(onCancel).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("validates that the plan path is required", async () => {
    const addToQueue = vi.fn();
    const onDone = vi.fn();
    const app = render(
      <QueuePrompt
        queuePath="/tmp/queue.json"
        onDone={onDone}
        onCancel={vi.fn()}
        addToQueueFn={addToQueue}
      />,
    );

    app.stdin.write("\r");
    await flushEffects();

    expect(addToQueue).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("Plan path is required.");

    app.unmount();
  });
});
