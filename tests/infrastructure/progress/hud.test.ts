import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendHudLines, buildStatusLine, HudView, type HudState } from "#infrastructure/progress/hud.js";
import { InkProgressSink } from "#infrastructure/progress/ink-progress-sink.js";
import { FakeHud } from "../../fakes/fake-hud.js";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const baseState = (overrides?: Partial<HudState>): HudState => ({
  executionMode: "sliced",
  totalSlices: 4,
  completedSlices: 1,
  currentSlice: { number: 2 },
  groupName: "Core",
  groupSliceCount: 3,
  groupCompleted: 1,
  activeAgent: "TDD",
  activeAgentActivity: "implementing",
  startTime: Date.now() - 5_000,
  ...overrides,
});

const renderHudView = (props: React.ComponentProps<typeof HudView>) =>
  render(React.createElement(HudView, props));

describe("HudView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders execution mode, slice progress, group info, active agent activity, and elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T10:00:05.000Z"));

    const app = renderHudView({
      items: [],
      state: baseState({ startTime: new Date("2026-04-10T10:00:00.000Z").valueOf() }),
      mode: "status",
      inputText: "",
      askLabel: "",
      skipping: false,
      activity: "planning...",
      spinIndex: 0,
      columns: 140,
    });

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Mode: sliced");
    expect(frame).toContain("S2/4");
    expect(frame).toContain("Group: Core");
    expect(frame).toContain("TDD: implementing");
    expect(frame).toContain("00:00:05");
    expect(frame).toContain("planning...");

    app.unmount();
  });

  it("renders guide and interrupt text input modes", () => {
    const guide = renderHudView({
      items: [],
      state: baseState(),
      mode: "guide",
      inputText: "focus on edges",
      askLabel: "",
      skipping: false,
      activity: "",
      spinIndex: 0,
      columns: 120,
    });

    expect(guide.lastFrame()).toContain("[Guide] Message for agent: focus on edges");
    guide.unmount();

    const interrupt = renderHudView({
      items: [],
      state: baseState(),
      mode: "interrupt",
      inputText: "rethink this",
      askLabel: "",
      skipping: false,
      activity: "",
      spinIndex: 0,
      columns: 120,
    });

    expect(interrupt.lastFrame()).toContain("[Interrupt] Message for agent: rethink this");
    interrupt.unmount();
  });
});

describe("HUD helpers", () => {
  it("respects the 400 line limit", () => {
    const lines: string[] = [];
    for (let index = 1; index <= 500; index += 1) {
      appendHudLines(lines, `line ${index}`);
    }

    expect(lines).toHaveLength(400);
    expect(lines[0]).toBe("line 101");
    expect(lines.at(-1)).toBe("line 500");
  });

  it("suppresses stale slice counters in direct mode", () => {
    const line = buildStatusLine(
      baseState({
        executionMode: "direct",
      }),
      140,
    );

    expect(line).toContain("Mode: direct");
    expect(line).not.toContain("S2/4");
  });
});

describe("InkProgressSink", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registerInterrupts wires guide, interrupt, skip, and quit callbacks", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);
    const guide = vi.fn<[string], void>();
    const interrupt = vi.fn<[string], void>();
    const quit = vi.fn<[], void>();

    let skipState = false;
    const handler = sink.registerInterrupts();
    handler.onGuide(guide);
    handler.onInterrupt(interrupt);
    handler.onSkip(() => {
      skipState = !skipState;
      return skipState;
    });
    handler.onQuit(quit);

    hud.simulateKey("g");
    hud.simulateKey("i");
    hud.simulateKey("s");
    hud.simulateKey("q");
    hud.simulateInterruptSubmit("focus on tests", "guide");
    hud.simulateInterruptSubmit("stop and rethink", "interrupt");

    expect(hud.promptsStarted).toEqual(["guide", "interrupt"]);
    expect(hud.skippingHistory).toEqual([true]);
    expect(guide).toHaveBeenCalledWith("focus on tests");
    expect(interrupt).toHaveBeenCalledWith("stop and rethink");
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("createStreamer pipes role-colored output to the HUD writer", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);

    const streamer = sink.createStreamer("tdd");
    streamer("implemented change\n");

    const output = stripAnsi(hud.logs.join(""));
    expect(output).toContain("│");
    expect(output).toContain("implemented change");
  });

  it("logBadge writes the phase label with the role badge", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);

    sink.logBadge("review", "review");

    const output = stripAnsi(hud.logs.join("\n"));
    expect(output).toContain("REV");
    expect(output).toContain("review");
  });

  it("shows planning activity on streamed text when no newer explicit activity supersedes it", () => {
    vi.useFakeTimers();

    const hud = new FakeHud();
    const sink = new InkProgressSink(hud, { planningDelayMs: 50 });
    sink.setActivity("plan");

    const streamer = sink.createStreamer("plan");
    streamer("Thinking through the slice");

    vi.advanceTimersByTime(49);
    expect(hud.activityHistory).toEqual(["plan"]);

    vi.advanceTimersByTime(1);
    expect(hud.activityHistory).toEqual(["plan", "planning..."]);
  });

  it("cancels pending planning activity when a newer explicit activity arrives", () => {
    vi.useFakeTimers();

    const hud = new FakeHud();
    const sink = new InkProgressSink(hud, { planningDelayMs: 50 });

    const streamer = sink.createStreamer("plan");
    streamer("Thinking...");
    sink.setActivity("waiting to retry");
    vi.advanceTimersByTime(50);

    expect(hud.activityHistory).toEqual(["waiting to retry"]);
  });
});
