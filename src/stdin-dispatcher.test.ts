import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "stream";
import { createStdinDispatcher } from "./stdin-dispatcher.js";

describe("createStdinDispatcher", () => {
  let fakeStdin: PassThrough & { setRawMode?: ReturnType<typeof vi.fn> };

  afterEach(() => {
    fakeStdin?.destroy();
  });

  it("routes bytes to a subscribed handler", () => {
    fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
    const dispatcher = createStdinDispatcher({ stdin: fakeStdin });
    const chunks: Buffer[] = [];

    dispatcher.subscribe((chunk) => chunks.push(chunk));
    fakeStdin.write(Buffer.from([0x13]));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.includes(0x13)).toBe(true);

    dispatcher.dispose();
  });

  it("routes bytes to multiple subscribers", () => {
    fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
    const dispatcher = createStdinDispatcher({ stdin: fakeStdin });
    const chunksA: Buffer[] = [];
    const chunksB: Buffer[] = [];

    dispatcher.subscribe((chunk) => chunksA.push(chunk));
    dispatcher.subscribe((chunk) => chunksB.push(chunk));
    fakeStdin.write(Buffer.from([0x07]));

    expect(chunksA).toHaveLength(1);
    expect(chunksB).toHaveLength(1);

    dispatcher.dispose();
  });

  it("unsubscribed handler stops receiving bytes", () => {
    fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
    const dispatcher = createStdinDispatcher({ stdin: fakeStdin });
    const chunks: Buffer[] = [];

    const unsub = dispatcher.subscribe((chunk) => chunks.push(chunk));
    unsub();
    fakeStdin.write(Buffer.from([0x13]));

    expect(chunks).toHaveLength(0);

    dispatcher.dispose();
  });

  it("enables raw mode on first subscribe, disables on last unsubscribe", () => {
    const setRawMode = vi.fn();
    fakeStdin = Object.assign(new PassThrough(), { setRawMode });
    const dispatcher = createStdinDispatcher({ stdin: fakeStdin });

    const unsubA = dispatcher.subscribe(() => {});
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(setRawMode).toHaveBeenCalledTimes(1);

    // Second subscribe should NOT call setRawMode again
    const unsubB = dispatcher.subscribe(() => {});
    expect(setRawMode).toHaveBeenCalledTimes(1);

    // First unsubscribe — still one subscriber, should NOT disable
    unsubA();
    expect(setRawMode).toHaveBeenCalledTimes(1);

    // Last unsubscribe — should disable raw mode
    unsubB();
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(setRawMode).toHaveBeenCalledTimes(2);
  });

  it("does not leak listeners across subscribe/unsubscribe cycles", () => {
    fakeStdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
    const dispatcher = createStdinDispatcher({ stdin: fakeStdin });
    const initial = fakeStdin.listenerCount("data");

    for (let i = 0; i < 5; i++) {
      const unsub = dispatcher.subscribe(() => {});
      unsub();
    }

    expect(fakeStdin.listenerCount("data")).toBe(initial);
    dispatcher.dispose();
  });

  it("raw mode stays on when one of two subscribers unsubscribes", () => {
    const setRawMode = vi.fn();
    fakeStdin = Object.assign(new PassThrough(), { setRawMode });
    const dispatcher = createStdinDispatcher({ stdin: fakeStdin });

    const unsubA = dispatcher.subscribe(() => {});
    dispatcher.subscribe(() => {});
    expect(setRawMode).toHaveBeenCalledTimes(1); // only first subscribe

    unsubA();
    // setRawMode(false) should NOT have been called — one subscriber remains
    expect(setRawMode).toHaveBeenCalledTimes(1);

    dispatcher.dispose();
  });

  it("dispose clears all subscribers and restores stdin", () => {
    const setRawMode = vi.fn();
    fakeStdin = Object.assign(new PassThrough(), { setRawMode });
    const dispatcher = createStdinDispatcher({ stdin: fakeStdin });
    const chunks: Buffer[] = [];

    dispatcher.subscribe((chunk) => chunks.push(chunk));
    dispatcher.subscribe(() => {});
    dispatcher.dispose();

    fakeStdin.write(Buffer.from([0x13]));
    expect(chunks).toHaveLength(0);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
  });
});
