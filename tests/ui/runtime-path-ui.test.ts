import { describe, expect, it, vi } from "vitest";
import { buildStatusLine, appendHudLines, HUD_MAX_LINES } from "#ui/hud.js";
import { InkOperatorGate, InkProgressSink } from "#ui/ink-operator-gate.js";
import { FakeHud } from "../fakes/fake-hud.js";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("shipped HUD helpers", () => {
  it("respects the 400 line limit on the live #ui/hud path", () => {
    const lines: string[] = [];

    for (let index = 1; index <= HUD_MAX_LINES + 100; index += 1) {
      appendHudLines(lines, `line ${index}`);
    }

    expect(lines).toHaveLength(HUD_MAX_LINES);
    expect(lines[0]).toBe("line 101");
    expect(lines.at(-1)).toBe(`line ${HUD_MAX_LINES + 100}`);
  });

  it("suppresses stale slice counters in direct mode on the live #ui/hud path", () => {
    const line = buildStatusLine(
      {
        executionMode: "direct",
        totalSlices: 4,
        completedSlices: 1,
        currentSlice: { number: 2 },
        groupName: "Core",
        groupSliceCount: 3,
        groupCompleted: 1,
        activeAgent: "TDD",
        activeAgentActivity: "implementing",
        startTime: Date.now() - 5_000,
      },
      140,
    );

    expect(line).toContain("Group: Core");
    expect(line).toContain("TDD: implementing");
    expect(line).not.toContain("S2/4");
  });
});

describe("shipped InkProgressSink", () => {
  it("registerInterrupts wires guide, interrupt, skip, and quit through the live #ui path", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);
    const guide = vi.fn<(text: string) => void>();
    const interrupt = vi.fn<(text: string) => void>();
    const quit = vi.fn<() => void>();

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

  it("clearSkipping resets the live HUD skip indicator after a skip was requested", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);

    let skipState = false;
    const handler = sink.registerInterrupts();
    handler.onSkip(() => {
      skipState = !skipState;
      return skipState;
    });

    hud.simulateKey("s");
    sink.clearSkipping();

    expect(hud.skippingHistory).toEqual([true, false]);
  });

  it("createStreamer pipes role-colored output to the live HUD writer", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);

    const streamer = sink.createStreamer("tdd");
    streamer("implemented change\n");

    const output = stripAnsi(hud.logs.join(""));
    expect(output).toContain("│");
    expect(output).toContain("implemented change");
  });

  it("logExecutionMode updates the HUD state and writes the live execution banner", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);

    sink.logExecutionMode("grouped");

    expect(hud.updates).toContainEqual({ executionMode: "grouped" });
    expect(stripAnsi(hud.logs.join("\n"))).toContain("Execution grouped");
  });

  it("logBadge writes the phase label with the live role badge", () => {
    const hud = new FakeHud();
    const sink = new InkProgressSink(hud);

    sink.logBadge("review", "review");

    const output = stripAnsi(hud.logs.join("\n"));
    expect(output).toContain("REV");
    expect(output).toContain("review");
  });
});

describe("shipped InkOperatorGate", () => {
  it("returns an edit decision with guidance through the live #ui gate", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("e", "tighten the plan");
    const gate = new InkOperatorGate(hud);

    await expect(gate.confirmPlan("preview")).resolves.toEqual({
      kind: "edit",
      guidance: "tighten the plan",
    });
  });

  it("returns false for confirmNextGroup when the operator answers n", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("n");
    const gate = new InkOperatorGate(hud);

    await expect(gate.confirmNextGroup("Group 2")).resolves.toBe(false);
  });
});
