import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  verifyWorktree: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  captureRef: vi.fn(),
}));

vi.mock("../src/state.js", () => ({
  saveState: vi.fn(),
}));

import { resolveWorktree } from "../src/worktree-setup.js";
import { createWorktree, verifyWorktree } from "../src/worktree.js";
import { captureRef } from "../src/git.js";
import { saveState } from "../src/state.js";

const noop = () => {};

describe("resolveWorktree", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns original cwd and skipStash=false when no branch", async () => {
    const state = {};
    const result = await resolveWorktree({
      branchName: undefined,
      cwd: "/repo",
      activePlanId: "abc123",
      state,
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(result.cwd).toBe("/repo");
    expect(result.skipStash).toBe(false);
    expect(result.updatedState).toBe(state);
    expect(result.worktreeInfo).toBeUndefined();
  });

  it("creates worktree and returns treePath as cwd on fresh run with --branch", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);

    const result = await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      activePlanId: "abc123",
      state: {},
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(createWorktree).toHaveBeenCalledWith("/repo", "abc123", "orch/abc123");
    expect(captureRef).toHaveBeenCalledWith("/repo");
    expect(result.cwd).toBe("/repo/.orch/trees/abc123");
    expect(result.skipStash).toBe(true);
    expect(result.worktreeInfo).toEqual({ path: "/repo/.orch/trees/abc123", branch: "orch/abc123" });
    expect(result.updatedState.worktree).toEqual({
      path: "/repo/.orch/trees/abc123",
      branch: "orch/abc123",
      baseSha: "deadbeef",
    });
  });

  it("persists worktree to state file on fresh creation", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);

    await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      activePlanId: "abc123",
      state: {},
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(saveState).toHaveBeenCalledWith("/repo/.orch/state/plan-abc123.json", {
      worktree: { path: "/repo/.orch/trees/abc123", branch: "orch/abc123", baseSha: "deadbeef" },
    });
  });

  it("verifies and reuses existing worktree from state on resume", async () => {
    vi.mocked(verifyWorktree).mockResolvedValue({ ok: true });
    const worktree = { path: "/repo/.orch/trees/abc123", branch: "orch/abc123", baseSha: "deadbeef" };
    const state = { lastCompletedSlice: 2, worktree };

    const result = await resolveWorktree({
      branchName: undefined,
      cwd: "/repo",
      activePlanId: "abc123",
      state,
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(verifyWorktree).toHaveBeenCalledWith("/repo/.orch/trees/abc123", "orch/abc123");
    expect(result.cwd).toBe("/repo/.orch/trees/abc123");
    expect(result.skipStash).toBe(true);
    expect(result.worktreeInfo).toEqual({ path: "/repo/.orch/trees/abc123", branch: "orch/abc123" });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("throws descriptive error when resume worktree verification fails", async () => {
    vi.mocked(verifyWorktree).mockResolvedValue({
      ok: false,
      reason: "missing",
      detail: "/repo/.orch/trees/abc123 does not exist",
    });
    const worktree = { path: "/repo/.orch/trees/abc123", branch: "orch/abc123", baseSha: "deadbeef" };

    await expect(
      resolveWorktree({
        branchName: undefined,
        cwd: "/repo",
        activePlanId: "abc123",
        state: { worktree },
        stateFile: "/repo/.orch/state/plan-abc123.json",
        log: noop,
      }),
    ).rejects.toThrow(/Worktree verification failed.*missing/);
  });

  it("reuses existing worktree from state even when --branch is passed again", async () => {
    vi.mocked(verifyWorktree).mockResolvedValue({ ok: true });
    const worktree = { path: "/repo/.orch/trees/abc123", branch: "orch/abc123", baseSha: "deadbeef" };

    const result = await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      activePlanId: "abc123",
      state: { worktree },
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(createWorktree).not.toHaveBeenCalled();
    expect(result.cwd).toBe("/repo/.orch/trees/abc123");
  });
});
