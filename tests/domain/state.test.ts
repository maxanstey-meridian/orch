import { afterEach, describe, it, expect, vi } from "vitest";
import { advanceState } from "#domain/state.js";
import type { OrchestratorState } from "#domain/state.js";

afterEach(() => {
  vi.useRealTimers();
});

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
    const next = advanceState({}, {
      kind: "agentSpawned",
      role: "tdd",
      session: { provider: "codex", id: "s1" },
    });
    expect(next).toEqual({ tddSession: { provider: "codex", id: "s1" } });
  });

  it("agentSpawned with role review updates reviewSessionId", () => {
    const next = advanceState({}, {
      kind: "agentSpawned",
      role: "review",
      session: { provider: "claude", id: "s2" },
    });
    expect(next).toEqual({ reviewSession: { provider: "claude", id: "s2" } });
  });

  it("agentSpawned does not mutate the original state", () => {
    const state: OrchestratorState = {};
    advanceState(state, {
      kind: "agentSpawned",
      role: "tdd",
      session: { provider: "codex", id: "s1" },
    });
    expect(state).toEqual({});
  });

  it("sliceDone preserves existing worktree and sessionIds", () => {
    const state: OrchestratorState = {
      tddSession: { provider: "codex", id: "t1" },
      reviewSession: { provider: "codex", id: "r1" },
      worktree: { path: "/tmp/wt", branch: "feat", baseSha: "base", managed: true },
    };
    const next = advanceState(state, { kind: "sliceDone", sliceNumber: 2 });
    expect(next.tddSession).toEqual({ provider: "codex", id: "t1" });
    expect(next.reviewSession).toEqual({ provider: "codex", id: "r1" });
    expect(next.worktree).toEqual({
      path: "/tmp/wt",
      branch: "feat",
      baseSha: "base",
      managed: true,
    });
    expect(next.lastCompletedSlice).toBe(2);
  });

  it("agentSpawned with role tdd overwrites existing tddSessionId", () => {
    const state: OrchestratorState = { tddSession: { provider: "claude", id: "old" } };
    const next = advanceState(state, {
      kind: "agentSpawned",
      role: "tdd",
      session: { provider: "codex", id: "new" },
    });
    expect(next.tddSession).toEqual({ provider: "codex", id: "new" });
  });

  it("sliceImplemented sets lastSliceImplemented and reviewBaseSha", () => {
    const next = advanceState({}, { kind: "sliceImplemented", sliceNumber: 3, reviewBaseSha: "abc123" });
    expect(next).toEqual({ lastSliceImplemented: 3, reviewBaseSha: "abc123" });
  });

  it("sliceImplemented preserves existing tddSessionId and lastCompletedSlice", () => {
    const state: OrchestratorState = {
      tddSession: { provider: "codex", id: "t1" },
      lastCompletedSlice: 2,
    };
    const next = advanceState(state, { kind: "sliceImplemented", sliceNumber: 3, reviewBaseSha: "abc123" });
    expect(next.tddSession).toEqual({ provider: "codex", id: "t1" });
    expect(next.lastCompletedSlice).toBe(2);
    expect(next.lastSliceImplemented).toBe(3);
    expect(next.reviewBaseSha).toBe("abc123");
  });

  it("sliceStarted sets currentSlice, currentGroup, and appends timing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:00:00.000Z"));

    const next = advanceState({}, { kind: "sliceStarted", sliceNumber: 2, groupName: "G1" });

    expect(next).toEqual({
      currentSlice: 2,
      currentGroup: "G1",
      startedAt: "2026-04-02T10:00:00.000Z",
      sliceTimings: [{ number: 2, startedAt: "2026-04-02T10:00:00.000Z" }],
    });
  });

  it("phaseEntered sets currentPhase", () => {
    const state: OrchestratorState = {
      currentSlice: 2,
      currentGroup: "G1",
      startedAt: "2026-04-02T10:00:00.000Z",
      sliceTimings: [{ number: 2, startedAt: "2026-04-02T10:00:00.000Z" }],
    };

    const next = advanceState(state, { kind: "phaseEntered", phase: "verify", sliceNumber: 2 });

    expect(next).toEqual({
      currentSlice: 2,
      currentGroup: "G1",
      currentPhase: "verify",
      startedAt: "2026-04-02T10:00:00.000Z",
      sliceTimings: [{ number: 2, startedAt: "2026-04-02T10:00:00.000Z" }],
    });
  });

  it("sliceDone sets completedAt on matching timing entry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:05:00.000Z"));

    const state: OrchestratorState = {
      startedAt: "2026-04-02T10:00:00.000Z",
      currentPhase: "tdd",
      sliceTimings: [
        { number: 1, startedAt: "2026-04-02T09:00:00.000Z", completedAt: "2026-04-02T09:30:00.000Z" },
        { number: 2, startedAt: "2026-04-02T10:00:00.000Z" },
      ],
    };

    const next = advanceState(state, { kind: "sliceDone", sliceNumber: 2 });

    expect(next).toEqual({
      startedAt: "2026-04-02T10:00:00.000Z",
      lastCompletedSlice: 2,
      lastSliceImplemented: 2,
      sliceTimings: [
        { number: 1, startedAt: "2026-04-02T09:00:00.000Z", completedAt: "2026-04-02T09:30:00.000Z" },
        { number: 2, startedAt: "2026-04-02T10:00:00.000Z", completedAt: "2026-04-02T10:05:00.000Z" },
      ],
    });
  });

  it("groupDone clears currentPhase after group work finishes", () => {
    const state: OrchestratorState = {
      executionMode: "grouped",
      currentPhase: "gap",
      currentGroup: "G1",
      lastCompletedSlice: 2,
    };

    const next = advanceState(state, { kind: "groupDone", groupName: "G1" });

    expect(next).toEqual({
      executionMode: "grouped",
      currentGroup: "G1",
      lastCompletedSlice: 2,
      lastCompletedGroup: "G1",
    });
  });

  it("multiple sliceStarted events append independent timing entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:00:00.000Z"));
    const afterFirst = advanceState({}, { kind: "sliceStarted", sliceNumber: 1, groupName: "G1" });

    vi.setSystemTime(new Date("2026-04-02T10:10:00.000Z"));
    const afterSecond = advanceState(afterFirst, {
      kind: "sliceStarted",
      sliceNumber: 2,
      groupName: "G1",
    });

    expect(afterSecond.sliceTimings).toEqual([
      { number: 1, startedAt: "2026-04-02T10:00:00.000Z" },
      { number: 2, startedAt: "2026-04-02T10:10:00.000Z" },
    ]);
  });

  it("sliceStarted does not duplicate timing if called twice for same slice number", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:00:00.000Z"));
    const first = advanceState({}, { kind: "sliceStarted", sliceNumber: 2, groupName: "G1" });

    vi.setSystemTime(new Date("2026-04-02T10:05:00.000Z"));
    const second = advanceState(first, { kind: "sliceStarted", sliceNumber: 2, groupName: "G2" });

    expect(second).toEqual({
      currentSlice: 2,
      currentGroup: "G2",
      startedAt: "2026-04-02T10:00:00.000Z",
      sliceTimings: [{ number: 2, startedAt: "2026-04-02T10:00:00.000Z" }],
    });
  });

  it("startedAt is preserved across events once set", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:00:00.000Z"));
    const started = advanceState({}, { kind: "sliceStarted", sliceNumber: 1, groupName: "G1" });

    vi.setSystemTime(new Date("2026-04-02T10:10:00.000Z"));
    const phaseEntered = advanceState(started, { kind: "phaseEntered", phase: "review", sliceNumber: 1 });

    vi.setSystemTime(new Date("2026-04-02T10:20:00.000Z"));
    const secondSlice = advanceState(phaseEntered, {
      kind: "sliceStarted",
      sliceNumber: 2,
      groupName: "G2",
    });

    vi.setSystemTime(new Date("2026-04-02T10:30:00.000Z"));
    const completed = advanceState(secondSlice, { kind: "sliceDone", sliceNumber: 2 });

    expect(completed.startedAt).toBe("2026-04-02T10:00:00.000Z");
  });
});
