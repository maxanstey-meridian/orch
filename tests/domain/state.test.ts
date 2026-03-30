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

  it("sliceDone preserves existing worktree and sessionIds", () => {
    const state: OrchestratorState = {
      tddSessionId: "t1",
      reviewSessionId: "r1",
      worktree: { path: "/tmp/wt", branch: "feat", baseSha: "base" },
    };
    const next = advanceState(state, { kind: "sliceDone", sliceNumber: 2 });
    expect(next.tddSessionId).toBe("t1");
    expect(next.reviewSessionId).toBe("r1");
    expect(next.worktree).toEqual({ path: "/tmp/wt", branch: "feat", baseSha: "base" });
    expect(next.lastCompletedSlice).toBe(2);
  });

  it("agentSpawned with role tdd overwrites existing tddSessionId", () => {
    const state: OrchestratorState = { tddSessionId: "old" };
    const next = advanceState(state, { kind: "agentSpawned", role: "tdd", sessionId: "new" });
    expect(next.tddSessionId).toBe("new");
  });

  it("sliceImplemented sets lastSliceImplemented and reviewBaseSha", () => {
    const next = advanceState({}, { kind: "sliceImplemented", sliceNumber: 3, reviewBaseSha: "abc123" });
    expect(next).toEqual({ lastSliceImplemented: 3, reviewBaseSha: "abc123" });
  });

  it("sliceImplemented preserves existing tddSessionId and lastCompletedSlice", () => {
    const state: OrchestratorState = { tddSessionId: "t1", lastCompletedSlice: 2 };
    const next = advanceState(state, { kind: "sliceImplemented", sliceNumber: 3, reviewBaseSha: "abc123" });
    expect(next.tddSessionId).toBe("t1");
    expect(next.lastCompletedSlice).toBe(2);
    expect(next.lastSliceImplemented).toBe(3);
    expect(next.reviewBaseSha).toBe("abc123");
  });
});
