import { describe, it, expect, beforeEach } from "vitest";
import { rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadState, saveState, clearState, statePathForPlan } from "#infrastructure/state/state.js";

const testPath = join(tmpdir(), `orch-state-test-${process.pid}.json`);

beforeEach(async () => {
  await rm(testPath, { force: true });
});

describe("state", () => {
  it("returns default state when file does not exist", async () => {
    const state = await loadState(testPath);
    expect(state).toEqual({});
  });

  it("persists lastCompletedSlice and loads it back", async () => {
    const state = { lastCompletedSlice: 5 };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it("persists direct executionMode and loads it back", async () => {
    const state = { executionMode: "direct" as const };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it("returns default state when file contains corrupt JSON", async () => {
    await writeFile(testPath, "{not valid json!!!");
    const state = await loadState(testPath);
    expect(state).toEqual({});
  });

  it("deletes state file on clear", async () => {
    await saveState(testPath, { lastCompletedSlice: 1 });
    await clearState(testPath);
    const state = await loadState(testPath);
    expect(state).toEqual({});
  });

  it("silently ignores clear when file does not exist", async () => {
    await expect(clearState(testPath)).resolves.toBeUndefined();
  });

  it("persists partial state with only some fields set", async () => {
    await saveState(testPath, { lastCompletedSlice: 3 });
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ lastCompletedSlice: 3 });
  });

  it("throws with field name when lastCompletedSlice has wrong type", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: "not-a-number" }));
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedSlice");
  });

  it("throws with field name when lastCompletedGroup has wrong type", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedGroup: 123 }));
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedGroup");
  });

  it("throws with field name when lastSliceImplemented has wrong type", async () => {
    await writeFile(testPath, JSON.stringify({ lastSliceImplemented: "nope" }));
    await expect(loadState(testPath)).rejects.toThrow("lastSliceImplemented");
  });

  it("throws when lastCompletedGroup is empty string", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedGroup: "" }));
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedGroup");
  });

  it("throws for non-integer numbers (NaN via JSON is unparseable, floats rejected)", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: 3.5 }));
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedSlice");
  });

  it("throws for Infinity (serialised as null by JSON.stringify)", async () => {
    // JSON.stringify(Infinity) => null, so the field becomes null which is wrong type
    await writeFile(testPath, '{"lastCompletedSlice": null}');
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedSlice");
  });

  it("throws for negative lastCompletedSlice", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: -1 }));
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedSlice");
  });

  it("throws for negative lastSliceImplemented", async () => {
    await writeFile(testPath, JSON.stringify({ lastSliceImplemented: -1 }));
    await expect(loadState(testPath)).rejects.toThrow("lastSliceImplemented");
  });

  it("persists lastCompletedGroup and loads it back", async () => {
    const state = { lastCompletedSlice: 3, lastCompletedGroup: "group-a" };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it("persists lastSliceImplemented and loads it back", async () => {
    const state = { lastCompletedSlice: 2, lastSliceImplemented: 3 };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it("overwrites previous state completely on save", async () => {
    await saveState(testPath, { lastCompletedSlice: 5 });
    await saveState(testPath, { lastCompletedSlice: 6 });
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ lastCompletedSlice: 6 });
  });

  it("preserves unknown fields via passthrough", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: 1, futureField: "hello" }));
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ lastCompletedSlice: 1, futureField: "hello" });
  });

  it("round-trips unknown fields through saveState then loadState", async () => {
    const state = { lastCompletedSlice: 2, futureField: "survives" } as any;
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ lastCompletedSlice: 2, futureField: "survives" });
  });

  it("loads empty object {} as valid state without throwing", async () => {
    await writeFile(testPath, "{}");
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({});
  });

  it("returns default state for non-object JSON values", async () => {
    // Arrays and primitives fail the z.object() check
    await writeFile(testPath, "[1,2,3]");
    await expect(loadState(testPath)).rejects.toThrow("Corrupt state file");

    await writeFile(testPath, '"hello"');
    await expect(loadState(testPath)).rejects.toThrow("Corrupt state file");
  });

  it("error message includes file path and recovery suggestion", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: "bad" }));
    await expect(loadState(testPath)).rejects.toThrow(testPath);
    await expect(loadState(testPath)).rejects.toThrow(
      "Delete the file to start fresh, or use --reset.",
    );
  });

  it("accepts lastCompletedSlice: 0 as a valid boundary value", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: 0 }));
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ lastCompletedSlice: 0 });
  });

  it("roundtrips state with all three fields populated", async () => {
    const state = { lastCompletedSlice: 3, lastCompletedGroup: "g1", lastSliceImplemented: 4 };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it("throws when lastCompletedSlice is a boolean (true)", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: true }));
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedSlice");
  });

  it("throws when lastCompletedSlice is a boolean (false)", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: false }));
    await expect(loadState(testPath)).rejects.toThrow("lastCompletedSlice");
  });

  it("NaN in raw JSON is unparseable and returns fresh state", async () => {
    await writeFile(testPath, '{"lastCompletedSlice": NaN}');
    // NaN is invalid JSON — JSON.parse throws
    const state = await loadState(testPath);
    expect(state).toEqual({});
  });

  it("throws Corrupt state file when top-level JSON value is null", async () => {
    await writeFile(testPath, "null");
    await expect(loadState(testPath)).rejects.toThrow("Corrupt state file");
  });

  it("throws when worktree.path is empty string", async () => {
    await writeFile(testPath, JSON.stringify({ worktree: { path: "", branch: "b", baseSha: "abc" } }));
    await expect(loadState(testPath)).rejects.toThrow("worktree");
  });

  it("throws when worktree.branch is empty string", async () => {
    await writeFile(testPath, JSON.stringify({ worktree: { path: "/tmp/wt", branch: "", baseSha: "abc" } }));
    await expect(loadState(testPath)).rejects.toThrow("worktree");
  });

  it("throws when worktree.baseSha is empty string", async () => {
    await writeFile(testPath, JSON.stringify({ worktree: { path: "/tmp/wt", branch: "b", baseSha: "" } }));
    await expect(loadState(testPath)).rejects.toThrow("worktree");
  });

  it("throws when worktree is missing required fields", async () => {
    await writeFile(testPath, JSON.stringify({ worktree: { path: "/tmp/wt" } }));
    await expect(loadState(testPath)).rejects.toThrow("worktree");
  });

  it("loads state without worktree field (backwards compat)", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: 5 }));
    const loaded = await loadState(testPath);
    expect(loaded.worktree).toBeUndefined();
    expect(loaded.lastCompletedSlice).toBe(5);
  });

  it("persists worktree field and loads it back", async () => {
    const state = {
      lastCompletedSlice: 1,
      worktree: { path: "/tmp/wt", branch: "orch/abc123", baseSha: "deadbeef" },
    };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it("persists provider-scoped tddSession and reviewSession", async () => {
    const state = {
      lastCompletedSlice: 1,
      tddSession: { provider: "codex" as const, id: "abc-123" },
      reviewSession: { provider: "claude" as const, id: "def-456" },
    };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded.tddSession).toEqual({ provider: "codex", id: "abc-123" });
    expect(loaded.reviewSession).toEqual({ provider: "claude", id: "def-456" });
  });

  it("throws when tddSession.id is empty string", async () => {
    await writeFile(testPath, JSON.stringify({ tddSession: { provider: "codex", id: "" } }));
    await expect(loadState(testPath)).rejects.toThrow("tddSession");
  });

  it("throws when reviewSession.id is empty string", async () => {
    await writeFile(testPath, JSON.stringify({ reviewSession: { provider: "claude", id: "" } }));
    await expect(loadState(testPath)).rejects.toThrow("reviewSession");
  });

  it("round-trips state with only tddSession (no reviewSession)", async () => {
    const state = { tddSession: { provider: "codex" as const, id: "abc-123" } };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded.tddSession).toEqual({ provider: "codex", id: "abc-123" });
    expect(loaded.reviewSession).toBeUndefined();
  });

  it("round-trips state with only reviewSession (no tddSession)", async () => {
    const state = { reviewSession: { provider: "claude" as const, id: "def-456" } };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded.reviewSession).toEqual({ provider: "claude", id: "def-456" });
    expect(loaded.tddSession).toBeUndefined();
  });

  it("throws when tddSession has invalid shape", async () => {
    await writeFile(testPath, JSON.stringify({ tddSession: 123 }));
    await expect(loadState(testPath)).rejects.toThrow("tddSession");
  });

  it("throws when reviewSession provider is invalid", async () => {
    await writeFile(testPath, JSON.stringify({ reviewSession: { provider: "openai", id: "x" } }));
    await expect(loadState(testPath)).rejects.toThrow("reviewSession");
  });

  it("persists phase and slice timing fields and loads them back", async () => {
    const state = {
      startedAt: "2026-04-02T10:00:00.000Z",
      currentPhase: "review" as const,
      currentSlice: 2,
      currentGroup: "G1",
      sliceTimings: [
        { number: 1, startedAt: "2026-04-02T10:00:00.000Z", completedAt: "2026-04-02T10:05:00.000Z" },
        { number: 2, startedAt: "2026-04-02T10:06:00.000Z" },
      ],
    };

    await saveState(testPath, state);
    const loaded = await loadState(testPath);

    expect(loaded).toEqual(state);
  });

  it("throws when currentPhase is not a supported persisted phase", async () => {
    await writeFile(testPath, JSON.stringify({ currentPhase: "executing" }));
    await expect(loadState(testPath)).rejects.toThrow("currentPhase");
  });

  it("throws when startedAt is not a string", async () => {
    await writeFile(testPath, JSON.stringify({ startedAt: 123 }));
    await expect(loadState(testPath)).rejects.toThrow("startedAt");
  });

  it("throws when currentSlice is negative", async () => {
    await writeFile(testPath, JSON.stringify({ currentSlice: -1 }));
    await expect(loadState(testPath)).rejects.toThrow("currentSlice");
  });

  it("throws when currentSlice is not an integer", async () => {
    await writeFile(testPath, JSON.stringify({ currentSlice: 1.5 }));
    await expect(loadState(testPath)).rejects.toThrow("currentSlice");
  });

  it("throws when currentGroup is an empty string", async () => {
    await writeFile(testPath, JSON.stringify({ currentGroup: "" }));
    await expect(loadState(testPath)).rejects.toThrow("currentGroup");
  });

  it("throws when sliceTimings contains an invalid entry", async () => {
    await writeFile(testPath, JSON.stringify({ sliceTimings: [{ number: "two", startedAt: "2026-04-02T10:00:00.000Z" }] }));
    await expect(loadState(testPath)).rejects.toThrow("sliceTimings");
  });

  it("throws when sliceTimings contains a non-string completedAt", async () => {
    await writeFile(
      testPath,
      JSON.stringify({
        sliceTimings: [{ number: 2, startedAt: "2026-04-02T10:00:00.000Z", completedAt: 123 }],
      }),
    );
    await expect(loadState(testPath)).rejects.toThrow("sliceTimings");
  });

  it("loads state without sessions (backwards compat)", async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: 5 }));
    const loaded = await loadState(testPath);
    expect(loaded.tddSession).toBeUndefined();
    expect(loaded.reviewSession).toBeUndefined();
  });

  it("drops legacy generic session IDs because they are provider-ambiguous", async () => {
    await writeFile(
      testPath,
      JSON.stringify({ tddSessionId: "old-tdd", reviewSessionId: "old-review", lastCompletedSlice: 5 }),
    );
    const loaded = await loadState(testPath);
    expect(loaded.lastCompletedSlice).toBe(5);
    expect(loaded.tddSession).toBeUndefined();
    expect(loaded.reviewSession).toBeUndefined();
  });
});

describe("saveState without parent directory", () => {
  it("throws ENOENT when parent directory does not exist", async () => {
    const missingDir = join(tmpdir(), `orch-nonexistent-${process.pid}`, "sub", "state.json");
    await expect(saveState(missingDir, { lastCompletedSlice: 1 })).rejects.toThrow("ENOENT");
  });
});

describe("statePathForPlan", () => {
  it("returns .orch/state/plan-<id>.json for a given orchDir and planId", () => {
    expect(statePathForPlan("/repo/.orch", "a1b2c3")).toBe("/repo/.orch/state/plan-a1b2c3.json");
  });

  it("handles trailing slash in orchDir without doubling", () => {
    expect(statePathForPlan("/repo/.orch/", "a1b2c3")).toBe("/repo/.orch/state/plan-a1b2c3.json");
  });

  it("path-traversal input escapes state directory (documents unsafe behaviour)", () => {
    const result = statePathForPlan("/repo/.orch", "../../etc");
    // join() resolves traversal segments — the path escapes .orch/state/
    // This is safe in practice because main.ts validates planId upstream,
    // but documents that statePathForPlan itself performs no validation.
    expect(result).toBe("/repo/.orch/state/etc.json");
    expect(result).not.toContain("plan-");
  });

  it("lastCompletedSlice is advanced and saved after a skip (round-trip)", async () => {
    const skipPath = join(tmpdir(), `orch-state-skip-${process.pid}.json`);
    await saveState(skipPath, { lastCompletedSlice: 2 });

    const state = await loadState(skipPath);
    const updated = { ...state, lastCompletedSlice: 3 };
    await saveState(skipPath, updated);

    const resumed = await loadState(skipPath);
    expect(resumed.lastCompletedSlice).toBe(3);

    await rm(skipPath, { force: true });
  });

  it("state saved for plan A does not affect state loaded for plan B", async () => {
    const orchDir = join(tmpdir(), `orch-state-isolation-${process.pid}`);
    const stateDir = join(orchDir, "state");
    const { mkdirSync } = await import("fs");
    mkdirSync(stateDir, { recursive: true });

    const pathA = statePathForPlan(orchDir, "aaa111");
    const pathB = statePathForPlan(orchDir, "bbb222");

    await saveState(pathA, { lastCompletedSlice: 5 });
    const stateB = await loadState(pathB);

    expect(stateB).toEqual({});

    // Cleanup
    await rm(orchDir, { recursive: true, force: true });
  });
});
