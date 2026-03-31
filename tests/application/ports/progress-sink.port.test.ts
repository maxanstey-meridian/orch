import { describe, it, expect } from "vitest";
import { ProgressSink } from "../../../src/application/ports/progress-sink.port.js";
import type { InterruptHandler, ProgressUpdate } from "../../../src/application/ports/progress-sink.port.js";
import type { AgentRole } from "../../../src/domain/agent-types.js";
import type { Slice } from "../../../src/domain/plan.js";
import { styleForRole } from "../../../src/ui/ink-operator-gate.js";

class TestProgressSink extends ProgressSink {
  registerInterrupts(): InterruptHandler {
    return { onGuide: () => {}, onInterrupt: () => {}, onSkip: () => {} };
  }
  updateProgress(_update: ProgressUpdate): void {}
  setActivity(_summary: string): void {}
  log(_text: string): void {}
  createStreamer(_role: AgentRole): (text: string) => void {
    return () => {};
  }
  logSliceIntro(_slice: Slice): void {}
  logBadge(_role: AgentRole, _phase: string): void {}
  teardown(): void {}
}

describe("ProgressSink", () => {
  it("is an abstract class", () => {
    expect(ProgressSink).toBeDefined();
    expect(typeof ProgressSink).toBe("function");
  });

  it("can be extended and instantiated", () => {
    const sink = new TestProgressSink();
    expect(sink).toBeInstanceOf(ProgressSink);
  });

  it("createStreamer returns a callable function", () => {
    const sink = new TestProgressSink();
    const streamer = sink.createStreamer("tdd");
    expect(typeof streamer).toBe("function");
  });
});

describe("InterruptHandler", () => {
  it("accepts valid handler object", () => {
    const sink = new TestProgressSink();
    const handler = sink.registerInterrupts();
    expect(typeof handler.onGuide).toBe("function");
    expect(typeof handler.onInterrupt).toBe("function");
    expect(typeof handler.onSkip).toBe("function");
  });
});

describe("ProgressUpdate", () => {
  it("accepts all hud.update() call shapes", () => {
    const shapes: ProgressUpdate[] = [
      { activeAgent: "TDD", activeAgentActivity: "executing plan..." },
      { activeAgent: undefined, activeAgentActivity: undefined },
      { completedSlices: 5 },
      { groupName: "Domain", groupSliceCount: 3, groupCompleted: 0 },
      { currentSlice: { number: 2 }, completedSlices: 1 },
      { totalSlices: 10, completedSlices: 0, startTime: Date.now() },
      { activeAgent: "GAP", activeAgentActivity: "scanning for gaps..." },
      { activeAgent: "REV", activeAgentActivity: "completeness check (slice 3)..." },
    ];

    expect(shapes).toHaveLength(8);
    shapes.forEach((s) => expect(s).toBeDefined());
  });
});

describe("logBadge", () => {
  it("logBadge is callable", () => {
    const sink = new TestProgressSink();
    sink.logBadge("tdd", "implementing...");
  });
});

describe("styleForRole", () => {
  it.each([
    ["tdd", "TDD"],
    ["review", "REVIEW"],
    ["gap", "GAP"],
    ["final", "FINAL"],
    ["verify", "VERIFY"],
    ["plan", "PLAN"],
    ["completeness", "PLAN"],
  ] as const)("maps %s → label %s", (role, expectedLabel) => {
    expect(styleForRole(role).label).toBe(expectedLabel);
  });
});
