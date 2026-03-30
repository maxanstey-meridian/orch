import { describe, it, expect } from "vitest";
import { ProgressSink } from "../../../src/application/ports/progress-sink.port.js";
import type { InterruptHandler, ProgressUpdate } from "../../../src/application/ports/progress-sink.port.js";

class TestProgressSink extends ProgressSink {
  registerInterrupts(): InterruptHandler {
    return { onGuide: () => {}, onInterrupt: () => {} };
  }
  updateProgress(_update: ProgressUpdate): void {}
  setActivity(_summary: string): void {}
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
});

describe("InterruptHandler", () => {
  it("accepts valid handler object", () => {
    const sink = new TestProgressSink();
    const handler = sink.registerInterrupts();
    expect(typeof handler.onGuide).toBe("function");
    expect(typeof handler.onInterrupt).toBe("function");
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
