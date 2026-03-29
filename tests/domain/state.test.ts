import { describe, it, expect } from "vitest";
import { advanceState } from "../../src/domain/state.js";
import type { OrchestratorState } from "../../src/domain/state.js";

describe("advanceState", () => {
  it("sliceDone updates lastCompletedSlice and lastSliceImplemented", () => {
    const state: OrchestratorState = {};
    const next = advanceState(state, { kind: "sliceDone", sliceNumber: 3 });
    expect(next).toEqual({ lastCompletedSlice: 3, lastSliceImplemented: 3 });
  });

  it("sliceDone does not mutate the original state", () => {
    const state: OrchestratorState = { lastCompletedSlice: 1 };
    advanceState(state, { kind: "sliceDone", sliceNumber: 2 });
    expect(state).toEqual({ lastCompletedSlice: 1 });
  });

  it("groupDone updates lastCompletedGroup", () => {
    const state: OrchestratorState = { lastCompletedSlice: 5 };
    const next = advanceState(state, { kind: "groupDone", groupName: "Domain" });
    expect(next).toEqual({ lastCompletedSlice: 5, lastCompletedGroup: "Domain" });
  });

  it("groupDone does not mutate the original state", () => {
    const state: OrchestratorState = {};
    advanceState(state, { kind: "groupDone", groupName: "Domain" });
    expect(state).toEqual({});
  });

  it("agentSpawned with role tdd updates tddSessionId", () => {
    const next = advanceState({}, { kind: "agentSpawned", role: "tdd", sessionId: "s1" });
    expect(next).toEqual({ tddSessionId: "s1" });
  });

  it("agentSpawned with role review updates reviewSessionId", () => {
    const next = advanceState({}, { kind: "agentSpawned", role: "review", sessionId: "s2" });
    expect(next).toEqual({ reviewSessionId: "s2" });
  });

  it("agentSpawned does not mutate the original state", () => {
    const state: OrchestratorState = {};
    advanceState(state, { kind: "agentSpawned", role: "tdd", sessionId: "s1" });
    expect(state).toEqual({});
  });

  it("reviewBaseCaptured updates reviewBaseSha", () => {
    const next = advanceState({}, { kind: "reviewBaseCaptured", sha: "abc123" });
    expect(next).toEqual({ reviewBaseSha: "abc123" });
  });

  it("reviewBaseCaptured does not mutate the original state", () => {
    const state: OrchestratorState = {};
    advanceState(state, { kind: "reviewBaseCaptured", sha: "abc123" });
    expect(state).toEqual({});
  });
});
