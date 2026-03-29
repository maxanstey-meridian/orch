import { describe, it, expect } from "vitest";
import {
  OperatorGate,
} from "../../../src/application/ports/operator-gate.port.js";
import type {
  GateDecision,
  VerifyDecision,
  InterruptHandler,
  ProgressUpdate,
} from "../../../src/application/ports/operator-gate.port.js";

describe("GateDecision", () => {
  it("accepts all three variants", () => {
    const accept: GateDecision = { kind: "accept" };
    const reject: GateDecision = { kind: "reject" };
    const edit: GateDecision = { kind: "edit", guidance: "fix tests" };

    expect(accept.kind).toBe("accept");
    expect(reject.kind).toBe("reject");
    expect(edit.kind).toBe("edit");
    expect(edit.guidance).toBe("fix tests");
  });
});

describe("VerifyDecision", () => {
  it("accepts all three variants", () => {
    const retry: VerifyDecision = { kind: "retry" };
    const skip: VerifyDecision = { kind: "skip" };
    const stop: VerifyDecision = { kind: "stop" };

    expect(retry.kind).toBe("retry");
    expect(skip.kind).toBe("skip");
    expect(stop.kind).toBe("stop");
  });
});

describe("InterruptHandler", () => {
  it("accepts valid handler object", () => {
    const handler: InterruptHandler = {
      onGuide: (_cb: (text: string) => void) => {},
      onInterrupt: (_cb: (text: string) => void) => {},
    };

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

class AutoOperatorGate extends OperatorGate {
  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    return { kind: "accept" };
  }
  async verifyFailed(_sliceNumber: number, _summary: string): Promise<VerifyDecision> {
    return { kind: "retry" };
  }
  async askUser(_prompt: string): Promise<string> {
    return "";
  }
  async confirmNextGroup(_groupLabel: string): Promise<boolean> {
    return true;
  }
  registerInterrupts(): InterruptHandler {
    return { onGuide: () => {}, onInterrupt: () => {} };
  }
  updateProgress(_update: ProgressUpdate): void {}
  setActivity(_summary: string): void {}
  teardown(): void {}
}

describe("OperatorGate", () => {
  it("can be extended with AutoOperatorGate", () => {
    const gate = new AutoOperatorGate();
    expect(gate).toBeInstanceOf(OperatorGate);
  });

  it("confirmPlan returns accept", async () => {
    const gate = new AutoOperatorGate();
    const decision = await gate.confirmPlan("some plan text");
    expect(decision).toEqual({ kind: "accept" });
  });

  it("verifyFailed returns retry", async () => {
    const gate = new AutoOperatorGate();
    const decision = await gate.verifyFailed(3, "tests failed");
    expect(decision).toEqual({ kind: "retry" });
  });

  it("askUser returns empty string", async () => {
    const gate = new AutoOperatorGate();
    const answer = await gate.askUser("Enter something:");
    expect(answer).toBe("");
  });

  it("confirmNextGroup returns true", async () => {
    const gate = new AutoOperatorGate();
    const confirmed = await gate.confirmNextGroup("Ports B");
    expect(confirmed).toBe(true);
  });

  it("display methods are no-ops", () => {
    const gate = new AutoOperatorGate();

    expect(() => gate.updateProgress({ completedSlices: 1 })).not.toThrow();
    expect(() => gate.setActivity("building...")).not.toThrow();
    expect(() => gate.teardown()).not.toThrow();

    const handler = gate.registerInterrupts();
    expect(() => handler.onGuide(() => {})).not.toThrow();
    expect(() => handler.onInterrupt(() => {})).not.toThrow();
  });
});
