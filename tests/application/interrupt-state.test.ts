import { describe, expect, it } from "vitest";
import { createInterruptState } from "#application/interrupt-state.js";

describe("createInterruptState", () => {
  it("starts with all flags false or null", () => {
    const state = createInterruptState();

    expect(state.skipRequested()).toBe(false);
    expect(state.quitRequested()).toBe(false);
    expect(state.hardInterrupt()).toBeNull();
  });

  it("toggleSkip flips the flag and returns the new state", () => {
    const state = createInterruptState();

    expect(state.toggleSkip()).toBe(true);
    expect(state.skipRequested()).toBe(true);
    expect(state.toggleSkip()).toBe(false);
    expect(state.skipRequested()).toBe(false);
  });

  it("requestQuit sets the quit flag", () => {
    const state = createInterruptState();

    state.requestQuit();

    expect(state.quitRequested()).toBe(true);
  });

  it("setHardInterrupt stores guidance", () => {
    const state = createInterruptState();

    state.setHardInterrupt("fix this");

    expect(state.hardInterrupt()).toBe("fix this");
  });

  it("clearHardInterrupt resets the stored guidance", () => {
    const state = createInterruptState();

    state.setHardInterrupt("x");
    state.clearHardInterrupt();

    expect(state.hardInterrupt()).toBeNull();
  });
});
