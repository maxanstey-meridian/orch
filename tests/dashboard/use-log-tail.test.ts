import { appendFile, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { tmpdir } from "os";
import { join } from "path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLogTail } from "#ui/dashboard/use-log-tail.js";

const HookProbe = ({ logPath }: { readonly logPath?: string }) => {
  const { lines, error } = useLogTail(logPath);

  return React.createElement(
    Text,
    null,
    JSON.stringify({
      count: lines.length,
      first: lines[0] ?? null,
      last: lines.at(-1) ?? null,
      error,
    }),
  );
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, intervalMs);
    });
  }

  throw new Error("Timed out waiting for expected output");
};

describe("useLogTail", () => {
  let tempDir = "";
  const makeLine = (index: number): string => `entry-${String(index).padStart(4, "0")}`;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dashboard-log-tail-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads existing log content on mount", async () => {
    const logPath = join(tempDir, "plan.log");
    await writeFile(logPath, "[ORCH] first\n[TDD] second\n");

    const app = render(React.createElement(HookProbe, { logPath }));

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return (
        frame.includes('"count":2') &&
        frame.includes('"first":"[ORCH] first"') &&
        frame.includes('"last":"[TDD] second"')
      );
    });

    app.unmount();
  });

  it("reports that the log is unavailable when no logPath is provided", async () => {
    const app = render(React.createElement(HookProbe, { logPath: undefined }));

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return frame.includes('"count":0') && frame.includes('"error":"Log file not available"');
    });

    app.unmount();
  });

  it("observes appended log content through fs.watch", async () => {
    const logPath = join(tempDir, "plan.log");
    await writeFile(logPath, "[ORCH] first\n");

    const app = render(React.createElement(HookProbe, { logPath }));

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return frame.includes('"count":1') && frame.includes('"last":"[ORCH] first"');
    });

    await appendFile(logPath, "[REVIEW] second\n");

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return frame.includes('"count":2') && frame.includes('"last":"[REVIEW] second"');
    });

    app.unmount();
  });

  it("caps the line buffer at 500 entries after the initial load", async () => {
    const logPath = join(tempDir, "plan.log");
    const content = Array.from({ length: 550 }, (_, index) => makeLine(index + 1))
      .join("\n")
      .concat("\n");
    await writeFile(logPath, content);

    const app = render(React.createElement(HookProbe, { logPath }));

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return frame.includes('"count":500') && frame.includes(`"last":"${makeLine(550)}"`);
    });

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain(`"first":"${makeLine(51)}"`);
    expect(frame).toContain(`"last":"${makeLine(550)}"`);
    expect(frame).not.toContain(makeLine(1));

    app.unmount();
  });

  it("caps the line buffer at 500 entries after appended updates", async () => {
    const logPath = join(tempDir, "plan.log");
    const initialContent = Array.from({ length: 499 }, (_, index) => makeLine(index + 1))
      .join("\n")
      .concat("\n");
    await writeFile(logPath, initialContent);

    const app = render(React.createElement(HookProbe, { logPath }));

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return frame.includes('"count":499') && frame.includes(`"last":"${makeLine(499)}"`);
    });

    await appendFile(logPath, `${makeLine(500)}\n${makeLine(501)}\n`);

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return frame.includes('"count":500') && frame.includes(`"last":"${makeLine(501)}"`);
    });

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain(`"first":"${makeLine(2)}"`);
    expect(frame).toContain(`"last":"${makeLine(501)}"`);
    expect(frame).not.toContain(makeLine(1));

    app.unmount();
  });

  it("surfaces a missing-file state and recovers once the log appears", async () => {
    const logPath = join(tempDir, "nested", "plan.log");
    const app = render(React.createElement(HookProbe, { logPath }));

    await waitFor(() => (app.lastFrame() ?? "").includes('"error":"Log file not found yet"'));

    await mkdir(join(tempDir, "nested"), { recursive: true });
    await writeFile(logPath, "[ORCH] recovered\n");

    await waitFor(() => {
      const frame = app.lastFrame() ?? "";
      return frame.includes('"last":"[ORCH] recovered"') && !frame.includes("Log file not found yet");
    });

    app.unmount();
  });
});
