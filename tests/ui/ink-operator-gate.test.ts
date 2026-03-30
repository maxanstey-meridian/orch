import { describe, it, expect, vi } from "vitest";
import { SilentOperatorGate, InkOperatorGate } from "../../src/ui/ink-operator-gate.js";
import type { Hud } from "../../src/ui/hud.js";

const createMockHud = (overrides: Partial<Hud> = {}): Hud => ({
  update: vi.fn(),
  teardown: vi.fn(),
  wrapLog: vi.fn((fn) => fn),
  createWriter: vi.fn(() => () => {}),
  onKey: vi.fn(),
  onInterruptSubmit: vi.fn(),
  startPrompt: vi.fn(),
  setSkipping: vi.fn(),
  setActivity: vi.fn(),
  askUser: vi.fn().mockResolvedValue(""),
  ...overrides,
});

describe("SilentOperatorGate", () => {
  it("confirmPlan returns accept", async () => {
    const gate = new SilentOperatorGate();
    const result = await gate.confirmPlan("any plan");
    expect(result).toEqual({ kind: "accept" });
  });

  it("verifyFailed returns retry", async () => {
    const gate = new SilentOperatorGate();
    const result = await gate.verifyFailed(3, "tests failed");
    expect(result).toEqual({ kind: "retry" });
  });

  it("askUser returns empty string", async () => {
    const gate = new SilentOperatorGate();
    const result = await gate.askUser("prompt");
    expect(result).toBe("");
  });

  it("confirmNextGroup returns true", async () => {
    const gate = new SilentOperatorGate();
    const result = await gate.confirmNextGroup("Ports B");
    expect(result).toBe(true);
  });

  it("display methods are callable no-ops", () => {
    const gate = new SilentOperatorGate();
    expect(() => gate.updateProgress({})).not.toThrow();
    expect(() => gate.setActivity("x")).not.toThrow();
    expect(() => gate.teardown()).not.toThrow();

    const handler = gate.registerInterrupts();
    expect(handler).toHaveProperty("onGuide");
    expect(handler).toHaveProperty("onInterrupt");
    // Callbacks are no-ops — calling them doesn't throw
    handler.onGuide(() => {});
    handler.onInterrupt(() => {});
  });
});

describe("InkOperatorGate", () => {
  describe("confirmPlan", () => {
    it("'y' returns accept", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("y") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.confirmPlan("plan text");
      expect(result).toEqual({ kind: "accept" });
      expect(hud.askUser).toHaveBeenCalledOnce();
    });

    it("'' (empty) returns accept", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.confirmPlan("plan text");
      expect(result).toEqual({ kind: "accept" });
    });

    it("'r' returns reject", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("r") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.confirmPlan("plan text");
      expect(result).toEqual({ kind: "reject" });
    });

    it("unrecognized input returns accept (fallthrough)", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("xyz") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.confirmPlan("plan text");
      expect(result).toEqual({ kind: "accept" });
    });

    it("'e' returns edit with guidance from second prompt", async () => {
      const hud = createMockHud({
        askUser: vi.fn()
          .mockResolvedValueOnce("e")
          .mockResolvedValueOnce("focus on edge cases"),
      });
      const gate = new InkOperatorGate(hud);
      const result = await gate.confirmPlan("plan text");
      expect(result).toEqual({ kind: "edit", guidance: "focus on edge cases" });
      expect(hud.askUser).toHaveBeenCalledTimes(2);
    });
  });

  describe("verifyFailed", () => {
    it("'r' returns retry", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("r") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.verifyFailed(3, "test summary");
      expect(result).toEqual({ kind: "retry" });
    });

    it("'' returns retry (default)", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.verifyFailed(3, "test summary");
      expect(result).toEqual({ kind: "retry" });
    });

    it("'s' returns skip", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("s") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.verifyFailed(3, "test summary");
      expect(result).toEqual({ kind: "skip" });
    });

    it("'t' returns stop", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("t") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.verifyFailed(3, "test summary");
      expect(result).toEqual({ kind: "stop" });
    });

    it("unrecognized input returns retry (fallthrough)", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("x") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.verifyFailed(3, "test summary");
      expect(result).toEqual({ kind: "retry" });
    });

    it("prompt includes slice number and summary", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("r") });
      const gate = new InkOperatorGate(hud);
      await gate.verifyFailed(7, "3 tests failed\nTypeError in foo.ts");
      const prompt = vi.mocked(hud.askUser).mock.calls[0][0];
      expect(prompt).toContain("7");
      expect(prompt).toContain("3 tests failed");
      expect(prompt).toContain("TypeError in foo.ts");
    });
  });

  describe("askUser", () => {
    it("delegates to hud.askUser", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("user input") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.askUser("Question?");
      expect(result).toBe("user input");
      expect(hud.askUser).toHaveBeenCalledWith("Question?");
    });
  });

  describe("confirmNextGroup", () => {
    it("'n' returns false", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("n") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.confirmNextGroup("Ports B (Slice 6, Slice 7)");
      expect(result).toBe(false);
    });

    it("'' returns true", async () => {
      const hud = createMockHud({ askUser: vi.fn().mockResolvedValueOnce("") });
      const gate = new InkOperatorGate(hud);
      const result = await gate.confirmNextGroup("Ports B");
      expect(result).toBe(true);
    });
  });

  describe("registerInterrupts", () => {
    it("returns InterruptHandler and wires hud handlers", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      const handler = gate.registerInterrupts();

      expect(handler).toHaveProperty("onGuide");
      expect(handler).toHaveProperty("onInterrupt");
      expect(hud.onKey).toHaveBeenCalled();
      expect(hud.onInterruptSubmit).toHaveBeenCalled();
    });

    it("dispatches guide text to onGuide callback", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      const handler = gate.registerInterrupts();

      const guideMessages: string[] = [];
      handler.onGuide((text) => guideMessages.push(text));

      // Simulate: user presses 'g' → hud.startPrompt('guide') called
      const keyHandler = vi.mocked(hud.onKey).mock.calls[0][0];
      keyHandler("g");
      expect(hud.startPrompt).toHaveBeenCalledWith("guide");

      // Simulate: user submits text in guide mode
      const submitHandler = vi.mocked(hud.onInterruptSubmit).mock.calls[0][0];
      submitHandler("fix the tests", "guide");
      expect(guideMessages).toEqual(["fix the tests"]);
    });

    it("unrecognized key does not call hud.startPrompt", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      gate.registerInterrupts();

      const keyHandler = vi.mocked(hud.onKey).mock.calls[0][0];
      keyHandler("x");
      keyHandler("z");
      expect(hud.startPrompt).not.toHaveBeenCalled();
    });

    it("submit before onGuide/onInterrupt registered does not throw", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      gate.registerInterrupts();
      // Don't register any callbacks via handler.onGuide / handler.onInterrupt

      const submitHandler = vi.mocked(hud.onInterruptSubmit).mock.calls[0][0];
      expect(() => submitHandler("some text", "guide")).not.toThrow();
      expect(() => submitHandler("some text", "interrupt")).not.toThrow();
    });

    it("dispatches interrupt text to onInterrupt callback", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      const handler = gate.registerInterrupts();

      const interruptMessages: string[] = [];
      handler.onInterrupt((text) => interruptMessages.push(text));

      const keyHandler = vi.mocked(hud.onKey).mock.calls[0][0];
      keyHandler("i");
      expect(hud.startPrompt).toHaveBeenCalledWith("interrupt");

      const submitHandler = vi.mocked(hud.onInterruptSubmit).mock.calls[0][0];
      submitHandler("stop and rethink", "interrupt");
      expect(interruptMessages).toEqual(["stop and rethink"]);
    });
  });

  describe("display delegation", () => {
    it("updateProgress delegates to hud.update", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      gate.updateProgress({ completedSlices: 5 });
      expect(hud.update).toHaveBeenCalledWith({ completedSlices: 5 });
    });

    it("setActivity delegates to hud.setActivity", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      gate.setActivity("building...");
      expect(hud.setActivity).toHaveBeenCalledWith("building...");
    });

    it("teardown delegates to hud.teardown", () => {
      const hud = createMockHud();
      const gate = new InkOperatorGate(hud);
      gate.teardown();
      expect(hud.teardown).toHaveBeenCalled();
    });
  });
});
