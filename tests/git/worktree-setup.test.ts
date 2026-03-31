import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/infrastructure/git/worktree.js", () => ({
  createWorktree: vi.fn(),
}));

vi.mock("../../src/infrastructure/git/git.js", () => ({
  captureRef: vi.fn(),
}));

vi.mock("../../src/infrastructure/state/state.js", () => ({
  saveState: vi.fn(),
}));

import { resolveWorktree } from "../../src/infrastructure/git/worktree-setup.js";
import { createWorktree } from "../../src/infrastructure/git/worktree.js";
import { captureRef } from "../../src/infrastructure/git/git.js";
import { saveState } from "../../src/infrastructure/state/state.js";

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

  it("reuses existing worktree from state on resume (checkWorktreeResume already verified)", async () => {
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

    expect(result.cwd).toBe("/repo/.orch/trees/abc123");
    expect(result.skipStash).toBe(true);
    expect(result.worktreeInfo).toEqual({ path: "/repo/.orch/trees/abc123", branch: "orch/abc123" });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("reuses existing worktree from state even when --branch is passed again", async () => {
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

  it("does not call saveState when createWorktree rejects", async () => {
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(createWorktree).mockRejectedValue(new Error("worktree add failed"));

    await expect(
      resolveWorktree({
        branchName: "orch/abc123",
        cwd: "/repo",
        activePlanId: "abc123",
        state: {},
        stateFile: "/repo/.orch/state/plan-abc123.json",
        log: noop,
      }),
    ).rejects.toThrow("worktree add failed");

    expect(saveState).not.toHaveBeenCalled();
  });

  it("does not call saveState when captureRef rejects", async () => {
    vi.mocked(captureRef).mockRejectedValue(new Error("not a git repo"));

    await expect(
      resolveWorktree({
        branchName: "orch/abc123",
        cwd: "/repo",
        activePlanId: "abc123",
        state: {},
        stateFile: "/repo/.orch/state/plan-abc123.json",
        log: noop,
      }),
    ).rejects.toThrow("not a git repo");

    expect(saveState).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("reuses existing worktree even when --branch specifies a different branch name", async () => {
    const worktree = { path: "/repo/.orch/trees/abc123", branch: "orch/abc123", baseSha: "deadbeef" };

    const result = await resolveWorktree({
      branchName: "orch/different-branch",
      cwd: "/repo",
      activePlanId: "abc123",
      state: { worktree },
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(createWorktree).not.toHaveBeenCalled();
    expect(result.cwd).toBe("/repo/.orch/trees/abc123");
    expect(result.worktreeInfo).toEqual({ path: "/repo/.orch/trees/abc123", branch: "orch/abc123" });
  });

  it("fresh creation preserves existing state fields in updatedState", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);

    const result = await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      activePlanId: "abc123",
      state: { lastCompletedSlice: 5 },
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(result.updatedState.lastCompletedSlice).toBe(5);
    expect(result.updatedState.worktree).toEqual({
      path: "/repo/.orch/trees/abc123",
      branch: "orch/abc123",
      baseSha: "deadbeef",
    });
  });
});
