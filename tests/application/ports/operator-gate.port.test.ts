import { describe, it, expect } from "vitest";
import {
  OperatorGate,
} from "../../../src/application/ports/operator-gate.port.js";
import type {
  GateDecision,
  VerifyDecision,
  CreditDecision,
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

class AutoOperatorGate extends OperatorGate {
  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    return { kind: "accept" };
  }
  async verifyFailed(_sliceNumber: number, _summary: string): Promise<VerifyDecision> {
    return { kind: "retry" };
  }
  async creditExhausted(_label: string, _message: string): Promise<CreditDecision> {
    return { kind: "retry" };
  }
  async askUser(_prompt: string): Promise<string> {
    return "";
  }
  async confirmNextGroup(_groupLabel: string): Promise<boolean> {
    return true;
  }
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

});
