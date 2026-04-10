import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStyle } from "#domain/agent-types.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import {
  createClaudeProcess,
  spawnClaudeAgent,
  spawnClaudePlanAgent,
} from "#infrastructure/agent/claude-process.js";
import { detectQuestion } from "#infrastructure/agent/question-detector.js";
import { makeStreamer } from "#infrastructure/agent/streamer.js";

type MockChildProcess = EventEmitter & {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: {
    readonly write: ReturnType<typeof vi.fn>;
  };
  readonly kill: ReturnType<typeof vi.fn>;
};

const TEST_STYLE: AgentStyle = { label: "TDD", color: "<cyan>", badge: "[TDD]" };

const createMockChildProcess = (): MockChildProcess => {
  const child = new EventEmitter() as MockChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: {
      write: vi.fn(),
    },
    kill: vi.fn(),
  });

  return child;
};

const emitAssistant = (
  child: MockChildProcess,
  content: ReadonlyArray<Record<string, unknown>>,
): void => {
  child.stdout.emit(
    "data",
    Buffer.from(
      `${JSON.stringify({
        type: "assistant",
        message: {
          content,
        },
      })}\n`,
    ),
  );
};

const emitResult = (child: MockChildProcess, result: string): void => {
  child.stdout.emit(
    "data",
    Buffer.from(
      `${JSON.stringify({
        type: "result",
        result,
        duration_ms: 1,
        num_turns: 1,
      })}\n`,
    ),
  );
};

describe("detectQuestion", () => {
  it("identifies direct user-facing questions", () => {
    expect(detectQuestion("What do you think?")).toBe(true);
  });

  it("ignores ordinary status output", () => {
    expect(detectQuestion("Implemented the slice and updated the tests.")).toBe(false);
  });
});

describe("makeStreamer", () => {
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 18,
    });
  });

  it("adds gutters, wraps long lines, and flushes trailing output", () => {
    const writes: string[] = [];
    const streamer = makeStreamer(TEST_STYLE, (text) => {
      writes.push(text);
    });

    streamer("alpha beta gamma delta");
    streamer.flush();

    const output = writes.join("");

    expect(output).toContain("<cyan>│\x1b[0m ");
    expect(output).toContain("\n<cyan>│\x1b[0m   ");
    expect(output.endsWith("\n")).toBe(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: originalColumns,
    });
  });
});

describe("spawnClaudeAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("uses skip-permissions mode and forwards resume/system/model args", () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const handle = spawnClaudeAgent(
      TEST_STYLE,
      "system prompt",
      "sess-123",
      "/repo",
      "claude-sonnet",
    );

    expect(handle.sessionId).toBe("sess-123");
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      [
        "--dangerously-skip-permissions",
        "--resume",
        "sess-123",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "claude-sonnet",
        "--append-system-prompt",
        "system prompt",
      ],
      {
        cwd: "/repo",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  });

  it("uses plan permission mode without resume for plan agents", () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    spawnClaudePlanAgent(TEST_STYLE, "plan prompt", "/repo", "claude-haiku");

    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      [
        "--permission-mode",
        "plan",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "claude-haiku",
        "--append-system-prompt",
        "plan prompt",
      ],
      {
        cwd: "/repo",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  });
});

describe("createClaudeProcess", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("captures assistant text, tool summaries, plan text, and user-input questions", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const process = createClaudeProcess({
      command: "claude",
      args: ["-p"],
      style: TEST_STYLE,
      sessionId: "sess-abc",
    });

    const pipedText = vi.fn();
    const pipedToolUse = vi.fn();
    process.pipe(pipedText, pipedToolUse);

    const resultPromise = process.send("Please continue");

    emitAssistant(child, [
      { type: "text", text: "What do you think?" },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/repo/src/example.ts" },
      },
      {
        type: "tool_use",
        name: "ExitPlanMode",
        input: { plan: "1. Implement it" },
      },
    ]);
    emitResult(child, "ok");

    const result = await resultPromise;

    expect(child.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "Please continue" },
        session_id: "sess-abc",
      })}\n`,
    );
    expect(result).toEqual({
      exitCode: 0,
      assistantText: "What do you think?",
      resultText: "ok",
      needsInput: true,
      sessionId: "sess-abc",
      planText: "1. Implement it",
    });
    expect(pipedText).toHaveBeenCalledWith("What do you think?");
    expect(pipedToolUse).toHaveBeenNthCalledWith(1, "Reading example.ts");
    expect(pipedToolUse).toHaveBeenNthCalledWith(2, "Plan ready");
    expect(pipedToolUse).toHaveBeenNthCalledWith(3, "");
  });

  it("supports quiet sends, guidance injection, stderr capture, and kill", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const process = createClaudeProcess({
      command: "claude",
      args: ["-p"],
      style: TEST_STYLE,
      sessionId: "sess-quiet",
    });

    child.stderr.emit("data", Buffer.from("api warning"));

    const quietPromise = process.sendQuiet("quiet prompt");
    emitResult(child, "quiet-result");

    await expect(quietPromise).resolves.toBe("quiet-result");

    process.inject("Need a fix");

    expect(child.stdin.write).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "[ORCHESTRATOR GUIDANCE] The operator has provided the following guidance. " +
            "You are still operating within an orchestrated TDD workflow — incorporate this guidance " +
            "into your current task, do not switch to freeform mode.\n\nNeed a fix",
        },
        session_id: "sess-quiet",
      })}\n`,
    );

    process.kill();

    expect(process.stderr).toBe("api warning");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("returns a non-zero result when the process dies mid-turn", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const process = createClaudeProcess({
      command: "claude",
      args: ["-p"],
      style: TEST_STYLE,
      sessionId: "sess-dead",
    });

    const resultPromise = process.send("run it");

    emitAssistant(child, [{ type: "text", text: "Halfway there." }]);
    child.emit("close", 9);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 9,
      assistantText: "Halfway there.",
      resultText: "",
      needsInput: false,
      sessionId: "sess-dead",
      planText: undefined,
    });
    expect(process.alive).toBe(false);
  });
});
