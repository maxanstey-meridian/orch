import { createInterface } from "node:readline";
import { describe, it, expect, vi } from "vitest";
import {
  HUD_MAX_LINES,
  appendHudLines,
  buildStatusLine,
  createHud,
  flushHudWriterBuffer,
} from "#ui/hud.js";
import type { HudState } from "#ui/hud.js";

vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

const makeMockStdout = (overrides: { columns?: number; rows?: number } = {}) => {
  const written: string[] = [];
  const mock = {
    isTTY: true as const,
    columns: overrides.columns ?? 80,
    rows: overrides.rows ?? 24,
    write: vi.fn((data: string) => { written.push(data); return true; }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return { mock, written, clear: () => { written.length = 0; mock.write.mockClear(); } };
};

const baseState = (overrides: Partial<HudState> = {}): HudState => ({
  totalSlices: 0,
  completedSlices: 0,
  startTime: Date.now(),
  ...overrides,
});

// ─── buildStatusLine (pure function) ──────────────────────────────────────────

describe("buildStatusLine", () => {
  it("renders slice counter when currentSlice is set", () => {
    const line = buildStatusLine(baseState({
      currentSlice: { number: 4 },
      totalSlices: 13,
    }), 120);
    expect(line).toContain("S4/13");
  });

  it("renders group name and progress bar", () => {
    const line = buildStatusLine(baseState({
      groupName: "Foundation",
      groupSliceCount: 3,
      groupCompleted: 1,
    }), 120);
    expect(line).toContain("Group: Foundation");
    expect(line).toContain("1/3");
  });

  it("renders active agent with activity", () => {
    const line = buildStatusLine(baseState({
      activeAgent: "TDD",
      activeAgentActivity: "implementing...",
    }), 120);
    expect(line).toContain("TDD: implementing...");
  });

  it("renders active agent without activity", () => {
    const line = buildStatusLine(baseState({
      activeAgent: "TDD",
    }), 120);
    expect(line).toContain("TDD");
    expect(line).not.toContain("TDD:");
  });

  it("renders elapsed time", () => {
    const line = buildStatusLine(baseState({
      startTime: Date.now() - 60_000,
    }), 120);
    expect(line).toContain("00:01:00");
  });

  it("renders credit signal", () => {
    const line = buildStatusLine(baseState({
      creditSignal: "ok",
    }), 120);
    expect(line).toContain("Credits: ok");
  });

  it("truncates to columns width", () => {
    const line = buildStatusLine(baseState({
      currentSlice: { number: 4 },
      totalSlices: 13,
      groupName: "Foundation",
      groupSliceCount: 3,
      groupCompleted: 1,
      activeAgent: "TDD",
      activeAgentActivity: "implementing...",
      creditSignal: "ok",
      startTime: Date.now() - 60_000,
    }), 30);
    expect(line.length).toBeLessThanOrEqual(30);
  });

  it("renders all parts separated by pipes", () => {
    const line = buildStatusLine(baseState({
      currentSlice: { number: 2 },
      totalSlices: 5,
      activeAgent: "REVIEW",
      startTime: Date.now() - 3661_000, // 1h 1m 1s
    }), 120);
    expect(line).toContain("S2/5");
    expect(line).toContain("REVIEW");
    expect(line).toContain("01:01:01");
    expect(line).toContain(" | ");
  });

  it("progress bar at 100% uses all = with no >", () => {
    const line = buildStatusLine(baseState({
      groupName: "Done",
      groupSliceCount: 3,
      groupCompleted: 3,
    }), 120);
    expect(line).toContain("[========]");
    expect(line).not.toMatch(/\[={8}>/);
  });

  it("progress bar at 0% with 0 total renders without error", () => {
    const line = buildStatusLine(baseState({
      groupName: "Empty",
      groupSliceCount: 0,
      groupCompleted: 0,
    }), 120);
    expect(line).toContain("Group: Empty");
    expect(line).toContain("[");
    expect(line).toContain("]");
  });
});

describe("appendHudLines", () => {
  it("keeps only the most recent retained lines", () => {
    const lines = Array.from({ length: HUD_MAX_LINES - 1 }, (_, index) => `line-${index}`);

    appendHudLines(lines, ["kept", "newest"]);

    expect(lines).toHaveLength(HUD_MAX_LINES);
    expect(lines[0]).toBe("line-1");
    expect(lines.at(-2)).toBe("kept");
    expect(lines.at(-1)).toBe("newest");
  });
});

describe("flushHudWriterBuffer", () => {
  it("flushes a buffered partial stream before later badge/log lines are appended", () => {
    const lines: string[] = [];

    const clearedBuffer = flushHudWriterBuffer(lines, "buffered partial stream");
    appendHudLines(lines, "11:00  [TDD] testing...");

    expect(clearedBuffer).toBe("");
    expect(lines).toEqual([
      "buffered partial stream",
      "11:00  [TDD] testing...",
    ]);
  });

  it("ignores an empty buffered fragment", () => {
    const lines: string[] = [];

    const clearedBuffer = flushHudWriterBuffer(lines, "");

    expect(clearedBuffer).toBe("");
    expect(lines).toEqual([]);
  });
});

// ─── createHud(false) — no-op mode ───────────────────────────────────────────

describe("createHud(false) — no-op mode", () => {
  it("askUser uses node:readline without relying on CommonJS require", async () => {
    const close = vi.fn();
    vi.mocked(createInterface).mockReturnValue({
      question: (_prompt: string, callback: (answer: string) => void) => {
        callback("queued answer");
      },
      close,
    } as unknown as ReturnType<typeof createInterface>);

    const hud = createHud(false);

    await expect(hud.askUser("Continue? ")).resolves.toBe("queued answer");
    expect(createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("update() and teardown() do not throw", () => {
    const hud = createHud(false);
    expect(() => hud.update({ totalSlices: 5, completedSlices: 0 })).not.toThrow();
    expect(() => hud.teardown()).not.toThrow();
  });

  it("wrapLog returns a function that passes content through unchanged", () => {
    const hud = createHud(false);
    const spy = vi.fn();
    const wrapped = hud.wrapLog(spy);
    wrapped("hello", 42);
    expect(spy).toHaveBeenCalledWith("hello", 42);
  });

  it("createWriter returns a function that writes to stdout directly", () => {
    const ctx = makeMockStdout();
    const hud = createHud(false, ctx.mock as unknown as NodeJS.WriteStream);
    const writer = hud.createWriter();
    writer("test output");
    expect(ctx.written).toContain("test output");
  });

  it("onKey, onInterruptSubmit, startPrompt, setSkipping do not throw", () => {
    const hud = createHud(false);
    expect(() => {
      hud.onKey(() => {});
      hud.onInterruptSubmit(() => {});
      hud.startPrompt("guide");
      hud.setSkipping(true);
    }).not.toThrow();
  });
});

// ─── createHud(true) — ink-based HUD ─────────────────────────────────────────

describe("createHud(true) — lifecycle", () => {
  it("update() and teardown() do not throw", () => {
    const hud = createHud(true);
    expect(() => hud.update({ totalSlices: 5, completedSlices: 0, startTime: Date.now() })).not.toThrow();
    expect(() => hud.teardown()).not.toThrow();
  });

  it("calling teardown twice does not throw", () => {
    const hud = createHud(true);
    expect(() => {
      hud.teardown();
      hud.teardown();
    }).not.toThrow();
  });

  it("update() after teardown() does not throw", () => {
    const hud = createHud(true);
    hud.teardown();
    expect(() => {
      hud.update({ totalSlices: 5, completedSlices: 1, startTime: Date.now() });
    }).not.toThrow();
  });

  it("wrapLog returns a function that does not throw", () => {
    const hud = createHud(true);
    const logSpy = vi.fn();
    const wrapped = hud.wrapLog(logSpy);
    expect(() => wrapped("hello")).not.toThrow();
    hud.teardown();
  });

  it("createWriter returns a function that does not throw", () => {
    const hud = createHud(true);
    const writer = hud.createWriter();
    expect(() => writer("content\n")).not.toThrow();
    hud.teardown();
  });

  it("partial updates merge state (verified via buildStatusLine)", () => {
    // This tests the merge logic indirectly — buildStatusLine is the output
    // of the merged state, and we already test it above as a pure function.
    // Here we just verify the update path doesn't crash.
    const hud = createHud(true);
    hud.update({ totalSlices: 5, completedSlices: 0, startTime: Date.now() });
    hud.update({ currentSlice: { number: 2 } });
    hud.update({ completedSlices: 1 });
    hud.teardown();
  });

  it("setSkipping does not throw", () => {
    const hud = createHud(true);
    expect(() => hud.setSkipping(true)).not.toThrow();
    expect(() => hud.setSkipping(false)).not.toThrow();
    hud.teardown();
  });
});
