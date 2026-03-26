import { describe, it, expect, afterEach, vi } from "vitest";
import { PassThrough } from "stream";
import { createInterruptHandler } from "./interrupt.js";
import { createStdinDispatcher, type StdinDispatcher } from "./stdin-dispatcher.js";

describe("createInterruptHandler", () => {
  describe("non-interactive mode (noInteraction: true)", () => {
    it("returns a handler whose methods do not throw", () => {
      const handler = createInterruptHandler(true);

      expect(() => handler.enable()).not.toThrow();
      expect(() => handler.disable()).not.toThrow();
      expect(() => handler.onInterrupt(() => {})).not.toThrow();
    });

    it("never fires the callback", () => {
      const handler = createInterruptHandler(true);
      const calls: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();

      // In non-interactive mode, nothing should ever fire
      expect(calls).toEqual([]);

      handler.disable();
    });
  });

  describe("interactive mode (noInteraction: false)", () => {
    let fakeStdin: PassThrough;
    let fakeStdout: PassThrough;
    let dispatcher: StdinDispatcher;

    afterEach(() => {
      dispatcher?.dispose();
      fakeStdin?.destroy();
      fakeStdout?.destroy();
    });

    const setup = (stdinOverrides?: Record<string, unknown>) => {
      fakeStdin = new PassThrough();
      fakeStdout = new PassThrough();
      if (stdinOverrides) Object.assign(fakeStdin, stdinOverrides);
      dispatcher = createStdinDispatcher({ stdin: fakeStdin });
      return createInterruptHandler(false, { dispatcher, stdout: fakeStdout });
    };

    it("fires callback with message when Ctrl+G followed by non-empty input", async () => {
      const handler = setup();
      const calls: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();

      // Simulate Ctrl+G (0x07)
      fakeStdin.write(Buffer.from([0x07]));

      // Wait for prompt to appear on stdout
      await new Promise<void>((resolve) => {
        fakeStdout.once("data", () => resolve());
      });

      // Simulate user typing a message and pressing Enter
      fakeStdin.write("focus on tests\n");

      // Wait for callback to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toEqual(["focus on tests"]);

      handler.disable();
    });

    it("prints 'Cancelled.' and does not fire callback on empty input", async () => {
      const handler = setup();
      const calls: string[] = [];
      const output: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();

      // Capture stdout
      fakeStdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));

      // Simulate Ctrl+G
      fakeStdin.write(Buffer.from([0x07]));

      // Wait for prompt
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate pressing Enter with no message
      fakeStdin.write("\n");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toEqual([]);
      expect(output.join("")).toContain("Cancelled.");

      handler.disable();
    });

    it("does not fire callback after disable()", async () => {
      const handler = setup();
      const calls: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();
      handler.disable();

      // Ctrl+G after disable should be ignored — no listener
      fakeStdin.write(Buffer.from([0x07]));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toEqual([]);
    });

    it("does not leak listeners across multiple enable/disable cycles", async () => {
      const handler = setup();

      const initialCount = fakeStdin.listenerCount("data");

      handler.enable();
      handler.disable();
      handler.enable();
      handler.disable();
      handler.enable();
      handler.disable();

      expect(fakeStdin.listenerCount("data")).toBe(initialCount);
    });

    it("ignores second Ctrl+G while already prompting", async () => {
      const handler = setup();
      const calls: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();

      // First Ctrl+G — opens prompt
      fakeStdin.write(Buffer.from([0x07]));
      await new Promise<void>((resolve) => {
        fakeStdout.once("data", () => resolve());
      });

      // Second Ctrl+G while first prompt is still open — should be ignored
      fakeStdin.write(Buffer.from([0x07]));
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Answer the first prompt
      fakeStdin.write("first answer\n");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Only one callback should have fired
      expect(calls).toEqual(["first answer"]);

      handler.disable();
    });

    it("enable() triggers raw mode via dispatcher subscribe", () => {
      const setRawMode = vi.fn();
      const handler = setup({ setRawMode });

      handler.enable();
      expect(setRawMode).toHaveBeenCalledWith(true);

      handler.disable();
      expect(setRawMode).toHaveBeenCalledWith(false);
    });

    it("strips embedded control characters from readline answer", async () => {
      const handler = setup();
      const calls: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();

      fakeStdin.write(Buffer.from([0x07]));
      await new Promise<void>((resolve) => {
        fakeStdout.once("data", () => resolve());
      });

      // Answer contains embedded 0x07 (stale Ctrl+G) and other control chars
      fakeStdin.write("\x07focus\x02 on tests\n");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toEqual(["focus on tests"]);

      handler.disable();
    });

    it("second onInterrupt call replaces the first callback", async () => {
      const handler = setup();
      const callsA: string[] = [];
      const callsB: string[] = [];

      handler.onInterrupt((msg) => callsA.push(msg));
      handler.onInterrupt((msg) => callsB.push(msg)); // replaces A

      handler.enable();

      fakeStdin.write(Buffer.from([0x07]));
      await new Promise<void>((resolve) => {
        fakeStdout.once("data", () => resolve());
      });
      fakeStdin.write("test\n");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(callsA).toEqual([]);
      expect(callsB).toEqual(["test"]);

      handler.disable();
    });

    it("disable() while prompting closes readline and does not fire callback", async () => {
      const handler = setup();
      const calls: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();

      // Send Ctrl+G to start prompting
      fakeStdin.write(Buffer.from([0x07]));
      await new Promise<void>((resolve) => {
        fakeStdout.once("data", () => resolve());
      });

      // Disable while prompt is still open (simulates agent finishing mid-prompt)
      handler.disable();

      // Try to answer — should not fire callback since readline was closed
      fakeStdin.write("late answer\n");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toEqual([]);
    });

    it("calling enable() twice does not double-register", async () => {
      const handler = setup();
      const calls: string[] = [];

      handler.onInterrupt((msg) => calls.push(msg));
      handler.enable();
      handler.enable(); // second call should be no-op

      // Send Ctrl+G + message
      fakeStdin.write(Buffer.from([0x07]));
      await new Promise<void>((resolve) => {
        fakeStdout.once("data", () => resolve());
      });
      fakeStdin.write("guidance\n");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should fire only once, not twice
      expect(calls).toEqual(["guidance"]);

      handler.disable();
    });
  });
});
