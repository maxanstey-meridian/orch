import { describe, it, expect, vi } from "vitest";
import { AGENT_ROLES } from "../../src/domain/agent-types.js";
import type { Slice } from "../../src/domain/plan.js";
import { SilentOperatorGate, InkOperatorGate, InkProgressSink, SilentProgressSink, styleForRole } from "../../src/ui/ink-operator-gate.js";
import type { Hud } from "../../src/ui/hud.js";
import { BOT_TDD, BOT_REVIEW, BOT_VERIFY, BOT_PLAN, BOT_GAP, BOT_FINAL } from "../../src/ui/display.js";

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

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

const makeSlice = (overrides: Partial<Slice> = {}): Slice => ({
  number: 3,
  title: "Test slice",
  content: "",
  why: "Test reason",
  files: [],
  details: "",
  tests: "",
  ...overrides,
});

describe("SilentOperatorGate", () => {
  it("confirmPlan returns accept", async () => {
    const gate = new SilentOperatorGate();
    const result = await gate.confirmPlan("any plan");
    expect(result).toEqual({ kind: "accept" });
  });

  it("verifyFailed returns skip", async () => {
    const gate = new SilentOperatorGate();
    const result = await gate.verifyFailed(3, "tests failed");
    expect(result).toEqual({ kind: "skip" });
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

});

describe("SilentProgressSink", () => {
  it("registerInterrupts returns no-op handlers", () => {
    const sink = new SilentProgressSink();
    const handler = sink.registerInterrupts();
    expect(typeof handler.onGuide).toBe("function");
    expect(typeof handler.onInterrupt).toBe("function");
    // Callbacks are no-ops — calling them doesn't throw
    handler.onGuide(() => {});
    handler.onInterrupt(() => {});
  });

  it("updateProgress is a no-op", () => {
    const sink = new SilentProgressSink();
    expect(() => sink.updateProgress({})).not.toThrow();
  });

  it("setActivity is a no-op", () => {
    const sink = new SilentProgressSink();
    expect(() => sink.setActivity("x")).not.toThrow();
  });

  it("createStreamer returns a no-op function", () => {
    const sink = new SilentProgressSink();
    const streamer = sink.createStreamer("tdd");

    expect(typeof streamer).toBe("function");
    expect(() => streamer("streamed text")).not.toThrow();
  });

  it("logSliceIntro is a no-op", () => {
    const sink = new SilentProgressSink();
    expect(() => sink.logSliceIntro(makeSlice())).not.toThrow();
  });

  it("logBadge is a no-op", () => {
    const sink = new SilentProgressSink();
    expect(() => sink.logBadge("tdd", "implementing...")).not.toThrow();
  });

  it("teardown is a no-op", () => {
    const sink = new SilentProgressSink();
    expect(() => sink.teardown()).not.toThrow();
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

});

describe("InkProgressSink", () => {
  it("maps every runtime agent role to its exact style", () => {
    const expectedStyles = {
      tdd: BOT_TDD,
      review: BOT_REVIEW,
      verify: BOT_VERIFY,
      plan: BOT_PLAN,
      gap: BOT_GAP,
      final: BOT_FINAL,
      completeness: BOT_PLAN,
    } as const;

    for (const role of AGENT_ROLES) {
      expect(styleForRole(role)).toBe(expectedStyles[role]);
    }
  });

  describe("registerInterrupts", () => {
    it("returns InterruptHandler and wires hud handlers", () => {
      const hud = createMockHud();
      const sink = new InkProgressSink(hud);
      const handler = sink.registerInterrupts();

      expect(handler).toHaveProperty("onGuide");
      expect(handler).toHaveProperty("onInterrupt");
      expect(hud.onKey).toHaveBeenCalled();
      expect(hud.onInterruptSubmit).toHaveBeenCalled();
    });

    it("dispatches guide text to onGuide callback", () => {
      const hud = createMockHud();
      const sink = new InkProgressSink(hud);
      const handler = sink.registerInterrupts();

      const guideMessages: string[] = [];
      handler.onGuide((text) => guideMessages.push(text));

      const keyHandler = vi.mocked(hud.onKey).mock.calls[0][0];
      keyHandler("g");
      expect(hud.startPrompt).toHaveBeenCalledWith("guide");

      const submitHandler = vi.mocked(hud.onInterruptSubmit).mock.calls[0][0];
      submitHandler("fix the tests", "guide");
      expect(guideMessages).toEqual(["fix the tests"]);
    });

    it("unrecognized key does not call hud.startPrompt", () => {
      const hud = createMockHud();
      const sink = new InkProgressSink(hud);
      sink.registerInterrupts();

      const keyHandler = vi.mocked(hud.onKey).mock.calls[0][0];
      keyHandler("x");
      keyHandler("z");
      expect(hud.startPrompt).not.toHaveBeenCalled();
    });

    it("submit before onGuide/onInterrupt registered does not throw", () => {
      const hud = createMockHud();
      const sink = new InkProgressSink(hud);
      sink.registerInterrupts();

      const submitHandler = vi.mocked(hud.onInterruptSubmit).mock.calls[0][0];
      expect(() => submitHandler("some text", "guide")).not.toThrow();
      expect(() => submitHandler("some text", "interrupt")).not.toThrow();
    });

    it("dispatches interrupt text to onInterrupt callback", () => {
      const hud = createMockHud();
      const sink = new InkProgressSink(hud);
      const handler = sink.registerInterrupts();

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

  it("updateProgress delegates to hud.update", () => {
    const hud = createMockHud();
    const sink = new InkProgressSink(hud);
    sink.updateProgress({ completedSlices: 5 });
    expect(hud.update).toHaveBeenCalledWith({ completedSlices: 5 });
  });

  it("setActivity delegates to hud.setActivity", () => {
    const hud = createMockHud();
    const sink = new InkProgressSink(hud);
    sink.setActivity("building...");
    expect(hud.setActivity).toHaveBeenCalledWith("building...");
  });

  it("createStreamer returns a callable function", () => {
    const hud = createMockHud();
    const sink = new InkProgressSink(hud);
    const streamer = sink.createStreamer("tdd");

    expect(typeof streamer).toBe("function");
    expect(() => streamer("streamed text")).not.toThrow();
  });

  it("logSliceIntro emits the bordered slice header", () => {
    const lines: string[] = [];
    const hud = createMockHud({
      wrapLog: vi.fn(() => (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
      }),
    });
    const sink = new InkProgressSink(hud);

    sink.logSliceIntro(makeSlice({ number: 3, title: "Test slice" }));

    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("┌─ Slice 3: Test slice");
    expect(text).toContain("│  Test reason");
    expect(text).toContain("└──");
  });

  it("logBadge emits a timestamp, TDD badge, and phase text", () => {
    const lines: string[] = [];
    const hud = createMockHud({
      wrapLog: vi.fn(() => (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
      }),
    });
    const sink = new InkProgressSink(hud);

    sink.logBadge("tdd", "implementing...");

    const text = stripAnsi(lines.join("\n"));
    expect(text).toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
    expect(text).toContain("TDD");
    expect(text).toContain("implementing...");
  });

  it("logBadge uses the review badge for review phases", () => {
    const lines: string[] = [];
    const hud = createMockHud({
      wrapLog: vi.fn(() => (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
      }),
    });
    const sink = new InkProgressSink(hud);

    sink.logBadge("review", "reviewing...");

    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("REV");
    expect(text).toContain("reviewing...");
    expect(text).not.toContain("TDD");
  });

  it("teardown delegates to hud.teardown", () => {
    const hud = createMockHud();
    const sink = new InkProgressSink(hud);
    sink.teardown();
    expect(hud.teardown).toHaveBeenCalled();
  });
});
