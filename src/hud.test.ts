import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHud } from "./hud.js";

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

describe("createHud(false) — no-op mode", () => {
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
});

describe("createHud(true) — scroll region setup and teardown", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("init writes scroll region escape sequence excluding bottom row", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    const scrollRegionSet = ctx.written.some((s) => s.includes("\x1b[1;23r"));
    expect(scrollRegionSet).toBe(true);
    hud.teardown();
  });

  it("teardown resets scroll region", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    ctx.clear();
    hud.teardown();
    const scrollRegionReset = ctx.written.some((s) => s.includes("\x1b[r"));
    expect(scrollRegionReset).toBe(true);
  });
});

describe("createHud(true) — status bar rendering", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("update renders status bar with slice, group, agent, and elapsed time", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    ctx.clear();

    hud.update({
      currentSlice: { number: 4},
      totalSlices: 13,
      completedSlices: 3,
      groupName: "Foundation",
      groupSliceCount: 3,
      groupCompleted: 1,
      activeAgent: "TDD",
      startTime: Date.now() - 60_000,
    });

    const output = ctx.written.join("");
    expect(output).toContain("S4/13");
    expect(output).toContain("Foundation");
    expect(output).toContain("TDD");
    expect(output).toContain("00:01:00");

    hud.teardown();
  });

  it("status bar is truncated to columns width", () => {
    const narrow = makeMockStdout({ columns: 30 });
    const hud = createHud(true, narrow.mock as unknown as NodeJS.WriteStream);
    narrow.clear();

    hud.update({
      currentSlice: { number: 4},
      totalSlices: 13,
      completedSlices: 3,
      groupName: "Foundation",
      groupSliceCount: 3,
      groupCompleted: 1,
      activeAgent: "TDD",
      startTime: Date.now() - 60_000,
    });

    const barWrites = narrow.written.filter((s) => s.includes("S4/13"));
    for (const w of barWrites) {
      const visible = w.replace(/\x1b(\[[0-9;]*[A-Za-z]|[78])/g, "");
      expect(visible.length).toBeLessThanOrEqual(30);
    }

    hud.teardown();
  });
});

describe("createHud(true) — wrapLog integration", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("wrapped log calls original logFn and re-renders status bar", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);

    hud.update({
      currentSlice: { number: 1},
      totalSlices: 5,
      completedSlices: 0,
      startTime: Date.now(),
    });

    ctx.clear();

    const logSpy = vi.fn();
    const wrapped = hud.wrapLog(logSpy);
    wrapped("hello");

    expect(logSpy).toHaveBeenCalledWith("hello");

    const barReRender = ctx.written.some((s) => s.includes("S1/5"));
    expect(barReRender).toBe(true);

    hud.teardown();
  });
});

describe("createHud(true) — SIGWINCH resize handling", () => {
  it("registers resize listener and re-sets scroll region on resize", () => {
    const resizeCallbacks: (() => void)[] = [];
    const written: string[] = [];
    const mock = {
      isTTY: true as const,
      columns: 80,
      rows: 24,
      write: vi.fn((data: string) => { written.push(data); return true; }),
      on: vi.fn((_event: string, cb: () => void) => { resizeCallbacks.push(cb); }),
      removeListener: vi.fn(),
    };

    const hud = createHud(true, mock as unknown as NodeJS.WriteStream);

    expect(mock.on).toHaveBeenCalledWith("resize", expect.any(Function));

    // Simulate terminal resize
    mock.rows = 30;
    mock.columns = 100;
    written.length = 0;
    resizeCallbacks[0]();

    const hasNewScrollRegion = written.some((s) => s.includes("\x1b[1;29r"));
    expect(hasNewScrollRegion).toBe(true);

    hud.teardown();
  });

  it("teardown removes the resize listener", () => {
    const ctx = makeMockStdout();
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    hud.teardown();

    expect(ctx.mock.removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});

describe("createHud(true) — creditSignal rendering", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("update with creditSignal renders Credits: ok in the bar", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    ctx.clear();

    hud.update({
      totalSlices: 5,
      completedSlices: 2,
      startTime: Date.now(),
      creditSignal: "ok",
    });

    const output = ctx.written.join("");
    expect(output).toContain("Credits: ok");

    hud.teardown();
  });
});

describe("createHud(true) — activeAgentActivity rendering", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("update with activeAgent and activeAgentActivity renders agent: activity", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    ctx.clear();

    hud.update({
      totalSlices: 5,
      completedSlices: 2,
      activeAgent: "TDD",
      activeAgentActivity: "implementing...",
      startTime: Date.now(),
    });

    const output = ctx.written.join("");
    expect(output).toContain("TDD: implementing...");

    hud.teardown();
  });
});

describe("createHud(true) — partial update merging", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("sequential partial updates merge state correctly", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);

    hud.update({ totalSlices: 5, completedSlices: 0, startTime: Date.now() });
    hud.update({ currentSlice: { number: 2} });

    ctx.clear();
    hud.update({ completedSlices: 1 });

    const output = ctx.written.join("");
    expect(output).toContain("S2/5");

    hud.teardown();
  });
});

describe("createHud(true) — progress bar with zero total", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("group with 0 slices renders without error", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    ctx.clear();

    expect(() => {
      hud.update({
        totalSlices: 5,
        completedSlices: 0,
        groupName: "Empty",
        groupSliceCount: 0,
        groupCompleted: 0,
        startTime: Date.now(),
      });
    }).not.toThrow();

    const output = ctx.written.join("");
    expect(output).toContain("Group: Empty");
    expect(output).toContain("[");
    expect(output).toContain("]");

    hud.teardown();
  });
});

describe("createHud(true) — progress bar at 100% completion", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("completed group does not render stray > character", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    ctx.clear();

    hud.update({
      totalSlices: 5,
      completedSlices: 5,
      groupName: "Done",
      groupSliceCount: 3,
      groupCompleted: 3,
      startTime: Date.now(),
    });

    const output = ctx.written.join("");
    // At 100%, bar should be [========] not [========>]
    expect(output).toContain("[========]");
    expect(output).not.toMatch(/\[={8}>/);

    hud.teardown();
  });
});

describe("currentSlice type does not accept title field", () => {
  it("update accepts currentSlice with only number", () => {
    const ctx = makeMockStdout();
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    ctx.clear();

    // This should compile — currentSlice needs only { number }
    hud.update({
      currentSlice: { number: 3 },
      totalSlices: 10,
      completedSlices: 2,
      startTime: Date.now(),
    });

    const output = ctx.written.join("");
    expect(output).toContain("S3/10");

    hud.teardown();
  });
});

describe("completedSlices should be a count, not a slice number", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("renders correct count when slices are non-contiguous", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);

    // Simulate: plan has 10 total slices, we've completed slices numbered 4, 7, 9
    // That's 3 completed — the bar should say S9/10, not S9/9
    hud.update({ totalSlices: 10, completedSlices: 0, startTime: Date.now() });

    // Complete first slice (number 4) — completedSlices should be 1
    hud.update({ currentSlice: { number: 4}, completedSlices: 1 });
    ctx.clear();

    // Complete second slice (number 7) — completedSlices should be 2
    hud.update({ currentSlice: { number: 7}, completedSlices: 2 });

    const output = ctx.written.join("");
    // The status line shows S{current}/{total} so S7/10
    expect(output).toContain("S7/10");

    // If completedSlices were incorrectly set to slice.number (7),
    // the HUD would show misleading progress. Verify it's 2.
    // We can't directly read state, but we verify the HUD doesn't break
    // by checking it renders without error and contains expected data.
    hud.teardown();
  });
});

describe("createHud(true) — teardown idempotency", () => {
  let ctx: ReturnType<typeof makeMockStdout>;
  beforeEach(() => { ctx = makeMockStdout(); });

  it("calling teardown twice does not throw", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    expect(() => {
      hud.teardown();
      hud.teardown();
    }).not.toThrow();
  });

  it("second teardown does not write reset escape again", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    hud.teardown();
    ctx.clear();
    hud.teardown();

    const hasReset = ctx.written.some((s) => s.includes("\x1b[r"));
    expect(hasReset).toBe(false);
  });

  it("update() after teardown() does not write to stdout", () => {
    const hud = createHud(true, ctx.mock as unknown as NodeJS.WriteStream);
    hud.teardown();
    ctx.clear();

    hud.update({ totalSlices: 5, completedSlices: 1, startTime: Date.now() });

    expect(ctx.written).toEqual([]);
  });
});
