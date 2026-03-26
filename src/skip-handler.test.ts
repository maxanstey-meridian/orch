import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "stream";
import { createSkipHandler } from "./skip-handler.js";
import { createStdinDispatcher, type StdinDispatcher } from "./stdin-dispatcher.js";
import { createInterruptHandler } from "./interrupt.js";

describe("createSkipHandler", () => {
  describe("disabled (enabled: false)", () => {
    it("cancel() does not throw", () => {
      const handler = createSkipHandler(false);
      expect(() => handler.cancel()).not.toThrow();
    });

    it("waitForSkip() never resolves — racing with a resolved promise always picks the other", async () => {
      const handler = createSkipHandler(false);
      const result = await Promise.race([
        handler.waitForSkip(),
        Promise.resolve("other"),
      ]);
      expect(result).toBe("other");
    });
  });

  describe("enabled (enabled: true)", () => {
    let fakeStdin: PassThrough & { setRawMode?: ReturnType<typeof vi.fn> };
    let dispatcher: StdinDispatcher;

    afterEach(() => {
      dispatcher?.dispose();
      fakeStdin?.destroy();
    });

    const setup = () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      return createSkipHandler(true, { dispatcher });
    };

    it("waitForSkip() resolves with true when 0x13 (Ctrl+S) is received", async () => {
      const handler = setup();

      const promise = handler.waitForSkip();
      fakeStdin.write(Buffer.from([0x13]));

      const result = await promise;
      expect(result).toBe(true);
    });

    it("cancel() resolves waitForSkip() with false before any keypress", async () => {
      const handler = setup();

      const promise = handler.waitForSkip();
      handler.cancel();

      const result = await promise;
      expect(result).toBe(false);
    });

    it("cancel() causes dispatcher to release raw mode when no other subscribers", async () => {
      const setRawMode = vi.fn();
      fakeStdin = Object.assign(new PassThrough(), { setRawMode });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const handler = createSkipHandler(true, { dispatcher });

      handler.waitForSkip();
      expect(setRawMode).toHaveBeenCalledWith(true);

      handler.cancel();
      expect(setRawMode).toHaveBeenCalledWith(false);
    });

    it("skip (0x13) causes dispatcher to release raw mode when no other subscribers", async () => {
      const setRawMode = vi.fn();
      fakeStdin = Object.assign(new PassThrough(), { setRawMode });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const handler = createSkipHandler(true, { dispatcher });

      const promise = handler.waitForSkip();
      fakeStdin.write(Buffer.from([0x13]));
      await promise;

      expect(setRawMode).toHaveBeenCalledWith(false);
    });

    it("ignores 0x13 while interrupt handler is prompting", async () => {
      const fakeStdout = new PassThrough();
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });

      const interrupt = createInterruptHandler(false, { dispatcher, stdout: fakeStdout });
      const skip = createSkipHandler(true, { dispatcher, suppress: interrupt });

      interrupt.enable();
      let skipFired = false;
      skip.waitForSkip().then(() => { skipFired = true; });

      // Trigger interrupt prompt (Ctrl+G)
      fakeStdin.write(Buffer.from([0x07]));
      await new Promise<void>((resolve) => {
        fakeStdout.once("data", () => resolve());
      });

      // While prompting, send Ctrl+S — should NOT trigger skip
      fakeStdin.write(Buffer.from([0x13]));
      // Let microtasks flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(skipFired).toBe(false);

      // Close the interrupt prompt so cleanup works
      fakeStdin.write("done\n");
      await new Promise((resolve) => setTimeout(resolve, 50));

      interrupt.disable();
      skip.cancel();
      fakeStdout.destroy();
    });

    it("accepts 0x13 when suppress.prompting is false", async () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const suppress = { prompting: false };
      const handler = createSkipHandler(true, { dispatcher, suppress });

      const promise = handler.waitForSkip();
      fakeStdin.write(Buffer.from([0x13]));

      const result = await promise;
      expect(result).toBe(true);
    });

    it("accepts 0x13 after suppress.prompting transitions from true to false", async () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const suppress = { prompting: true };
      const handler = createSkipHandler(true, { dispatcher, suppress });

      let skipFired = false;
      const promise = handler.waitForSkip();
      promise.then(() => { skipFired = true; });

      // First Ctrl+S while suppressed — ignored
      fakeStdin.write(Buffer.from([0x13]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(skipFired).toBe(false);

      // Unsuppress and send another Ctrl+S
      suppress.prompting = false;
      fakeStdin.write(Buffer.from([0x13]));

      const result = await promise;
      expect(result).toBe(true);
    });

    it("second handler on same dispatcher works after first is cancelled", async () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });

      const first = createSkipHandler(true, { dispatcher });
      first.waitForSkip();
      first.cancel();

      const second = createSkipHandler(true, { dispatcher });
      const promise = second.waitForSkip();
      fakeStdin.write(Buffer.from([0x13]));

      const result = await promise;
      expect(result).toBe(true);
    });

    it("cancel() before waitForSkip() does not throw or leak", () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const handler = createSkipHandler(true, { dispatcher });

      expect(() => handler.cancel()).not.toThrow();
      expect(fakeStdin.listenerCount("data")).toBe(0);
    });

    it("ignores non-0x13 bytes — promise stays unresolved", async () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const handler = createSkipHandler(true, { dispatcher });

      let resolved = false;
      handler.waitForSkip().then(() => { resolved = true; });

      fakeStdin.write(Buffer.from([0x07, 0x41, 0x0a]));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(resolved).toBe(false);
      handler.cancel();
    });

    it("multiple create/cancel cycles do not leak dispatcher subscriptions", () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const initialCount = fakeStdin.listenerCount("data");

      for (let i = 0; i < 5; i++) {
        const handler = createSkipHandler(true, { dispatcher });
        handler.waitForSkip();
        handler.cancel();
      }

      expect(fakeStdin.listenerCount("data")).toBe(initialCount);
    });
  });

  describe("race pattern (mirrors main.ts wiring)", () => {
    let fakeStdin: PassThrough & { setRawMode?: ReturnType<typeof vi.fn> };
    let dispatcher: StdinDispatcher;

    afterEach(() => {
      dispatcher?.dispose();
      fakeStdin?.destroy();
    });

    it("tdd resolves first → race picks done and skip is cancelled", async () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const skip = createSkipHandler(true, { dispatcher });

      const tddPromise = Promise.resolve({ exitCode: 0, text: "done" });

      const raceResult = await Promise.race([
        tddPromise.then((r) => { skip.cancel(); return { kind: "done" as const, result: r }; }),
        skip.waitForSkip().then((skipped) => ({ kind: "skip" as const, skipped })),
      ]);

      expect(raceResult.kind).toBe("done");
      if (raceResult.kind === "done") {
        expect(raceResult.result.exitCode).toBe(0);
      }
    });

    it("skip fires first → race picks skip while tdd is still pending", async () => {
      fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      const skip = createSkipHandler(true, { dispatcher });

      // tddPromise never resolves (simulates a long-running agent)
      const tddPromise = new Promise<{ exitCode: number }>(() => {});

      const skipPromise = skip.waitForSkip();
      // Emit Ctrl+S before tdd resolves
      fakeStdin.write(Buffer.from([0x13]));

      const raceResult = await Promise.race([
        tddPromise.then((r) => { skip.cancel(); return { kind: "done" as const, result: r }; }),
        skipPromise.then((skipped) => ({ kind: "skip" as const, skipped })),
      ]);

      expect(raceResult).toEqual({ kind: "skip", skipped: true });
    });
  });
});
