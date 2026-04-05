import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/infrastructure/git/worktree.js", () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("../../src/infrastructure/git/git.js", () => ({
  captureRef: vi.fn(),
  captureCurrentBranch: vi.fn(),
}));

vi.mock("../../src/infrastructure/state/state.js", () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
}));

import { resolveWorktree } from "#infrastructure/git/worktree-setup.js";
import { createWorktree, removeWorktree } from "#infrastructure/git/worktree.js";
import { captureCurrentBranch, captureRef } from "#infrastructure/git/git.js";
import { loadState, saveState } from "#infrastructure/state/state.js";
import { execFile } from "child_process";

const noop = () => {};
const mockedExecFile = vi.mocked(execFile);
type ExecFileImplementation = Parameters<typeof mockedExecFile.mockImplementation>[0];
type ExecFileArgs = ExecFileImplementation extends (...args: infer Args) => unknown ? Args : never;
type ExecFileCallback = ExecFileArgs[3];

const completeExecFileCall = (
  callback: ExecFileCallback,
  error: Error | null,
  stdout = "",
  stderr = "",
): void => {
  callback?.(error, stdout, stderr);
};

describe("resolveWorktree", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadState).mockResolvedValue({});
  });

  it("returns original cwd and skipStash=false when no branch", async () => {
    const state = {};
    const result = await resolveWorktree({
      branchName: undefined,
      cwd: "/repo",
      treePath: undefined,
      worktreeSetup: [],
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
      treePath: undefined,
      worktreeSetup: [],
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
      managed: true,
    });
  });

  it("persists worktree to state file on fresh creation", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);

    await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      treePath: undefined,
      worktreeSetup: [],
      activePlanId: "abc123",
      state: {},
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(saveState).toHaveBeenCalledWith("/repo/.orch/state/plan-abc123.json", {
      worktree: {
        path: "/repo/.orch/trees/abc123",
        branch: "orch/abc123",
        baseSha: "deadbeef",
        managed: true,
      },
    });
  });

  it("uses an external tree as cwd without creating a managed worktree", async () => {
    vi.mocked(captureCurrentBranch).mockResolvedValue("feature/existing");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);

    const result = await resolveWorktree({
      branchName: undefined,
      cwd: "/repo",
      treePath: "/repo-existing-tree",
      worktreeSetup: ["pnpm install"],
      activePlanId: "abc123",
      state: {},
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(result.cwd).toBe("/repo-existing-tree");
    expect(result.skipStash).toBe(true);
    expect(result.worktreeInfo).toEqual({
      path: "/repo-existing-tree",
      branch: "feature/existing",
    });
    expect(result.updatedState.worktree).toEqual({
      path: "/repo-existing-tree",
      branch: "feature/existing",
      baseSha: "deadbeef",
      managed: false,
    });
    expect(captureCurrentBranch).toHaveBeenCalledWith("/repo-existing-tree");
    expect(captureRef).toHaveBeenCalledWith("/repo-existing-tree");
    expect(createWorktree).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("persists external tree metadata onto the current saved state instead of stale state input", async () => {
    vi.mocked(loadState).mockResolvedValue({
      startedAt: "2026-04-04T10:00:00.000Z",
      tier: "medium",
      currentPhase: "plan",
    });
    vi.mocked(captureCurrentBranch).mockResolvedValue("feature/existing");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);

    await resolveWorktree({
      branchName: undefined,
      cwd: "/repo",
      treePath: "/repo-existing-tree",
      worktreeSetup: [],
      activePlanId: "abc123",
      state: {},
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(saveState).toHaveBeenCalledWith("/repo/.orch/state/plan-abc123.json", {
      startedAt: "2026-04-04T10:00:00.000Z",
      tier: "medium",
      currentPhase: "plan",
      worktree: {
        path: "/repo-existing-tree",
        branch: "feature/existing",
        baseSha: "deadbeef",
        managed: false,
      },
    });
  });

  it("reuses existing external worktree state on resume without recapturing or persisting", async () => {
    const worktree = {
      path: "/external-checkouts/feature-branch",
      branch: "feature/external-tree",
      baseSha: "deadbeef",
      managed: false,
    };
    const state = { lastCompletedSlice: 2, worktree };

    const result = await resolveWorktree({
      branchName: undefined,
      cwd: "/repo",
      treePath: undefined,
      worktreeSetup: ["pnpm install"],
      activePlanId: "abc123",
      state,
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(result.cwd).toBe("/external-checkouts/feature-branch");
    expect(result.skipStash).toBe(true);
    expect(result.worktreeInfo).toEqual({
      path: "/external-checkouts/feature-branch",
      branch: "feature/external-tree",
    });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(captureCurrentBranch).not.toHaveBeenCalled();
    expect(captureRef).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("reuses persisted external worktree state even when the same --tree path is passed again", async () => {
    const worktree = {
      path: "/external-checkouts/feature-branch",
      branch: "feature/external-tree",
      baseSha: "deadbeef",
      managed: false,
    };
    const state = { lastCompletedSlice: 2, worktree };

    const result = await resolveWorktree({
      branchName: undefined,
      cwd: "/repo",
      treePath: "/external-checkouts/feature-branch",
      worktreeSetup: ["pnpm install"],
      activePlanId: "abc123",
      state,
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(result.cwd).toBe("/external-checkouts/feature-branch");
    expect(result.skipStash).toBe(true);
    expect(result.worktreeInfo).toEqual({
      path: "/external-checkouts/feature-branch",
      branch: "feature/external-tree",
    });
    expect(result.updatedState.worktree).toEqual(worktree);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(captureCurrentBranch).not.toHaveBeenCalled();
    expect(captureRef).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("reuses existing worktree from state even when --branch is passed again", async () => {
    const worktree = {
      path: "/repo/.orch/trees/abc123",
      branch: "orch/abc123",
      baseSha: "deadbeef",
      managed: true,
    };

    const result = await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      treePath: undefined,
      worktreeSetup: ["pnpm install"],
      activePlanId: "abc123",
      state: { worktree },
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(createWorktree).not.toHaveBeenCalled();
    expect(result.cwd).toBe("/repo/.orch/trees/abc123");
    expect(execFile).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("does not call saveState when createWorktree rejects", async () => {
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(createWorktree).mockRejectedValue(new Error("worktree add failed"));

    await expect(
      resolveWorktree({
        branchName: "orch/abc123",
        cwd: "/repo",
        treePath: undefined,
        worktreeSetup: [],
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
        treePath: undefined,
        worktreeSetup: [],
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
    const worktree = {
      path: "/repo/.orch/trees/abc123",
      branch: "orch/abc123",
      baseSha: "deadbeef",
      managed: true,
    };

    const result = await resolveWorktree({
      branchName: "orch/different-branch",
      cwd: "/repo",
      treePath: undefined,
      worktreeSetup: ["pnpm install"],
      activePlanId: "abc123",
      state: { worktree },
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(createWorktree).not.toHaveBeenCalled();
    expect(result.cwd).toBe("/repo/.orch/trees/abc123");
    expect(result.worktreeInfo).toEqual({ path: "/repo/.orch/trees/abc123", branch: "orch/abc123" });
    expect(execFile).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("fresh creation preserves existing state fields in updatedState", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);

    const result = await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      treePath: undefined,
      worktreeSetup: [],
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
      managed: true,
    });
  });

  it("runs managed worktree setup commands sequentially in the created worktree cwd", async () => {
    const shell = process.env.SHELL ?? "/bin/sh";
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(saveState).mockResolvedValue(undefined);
    const successImplementation: NonNullable<ExecFileImplementation> = (
      ...args: ExecFileArgs
    ) => {
      completeExecFileCall(args[3], null, "", "");
      return {} as ReturnType<typeof execFile>;
    };
    mockedExecFile.mockImplementation(successImplementation);

    await resolveWorktree({
      branchName: "orch/abc123",
      cwd: "/repo",
      treePath: undefined,
      worktreeSetup: ["echo first", "echo second"],
      activePlanId: "abc123",
      state: {},
      stateFile: "/repo/.orch/state/plan-abc123.json",
      log: noop,
    });

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      shell,
      ["-lc", "echo first"],
      expect.objectContaining({ cwd: "/repo/.orch/trees/abc123", encoding: "utf-8" }),
      expect.any(Function),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      shell,
      ["-lc", "echo second"],
      expect.objectContaining({ cwd: "/repo/.orch/trees/abc123", encoding: "utf-8" }),
      expect.any(Function),
    );
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("aborts managed worktree setup on the first failing command and does not persist state", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    const failingImplementation: NonNullable<ExecFileImplementation> = (
      ...args: ExecFileArgs
    ) => {
      const command = args[1]?.[1];
      if (command === "echo first") {
        completeExecFileCall(args[3], null, "", "");
        return {} as ReturnType<typeof execFile>;
      }

      const error = new Error("command failed");
      completeExecFileCall(args[3], error, "stdout line", "stderr line");
      return {} as ReturnType<typeof execFile>;
    };
    mockedExecFile.mockImplementation(failingImplementation);

    await expect(
      resolveWorktree({
        branchName: "orch/abc123",
        cwd: "/repo",
        treePath: undefined,
        worktreeSetup: ["echo first", "echo second", "echo third"],
        activePlanId: "abc123",
        state: {},
        stateFile: "/repo/.orch/state/plan-abc123.json",
        log: noop,
      }),
    ).rejects.toThrow("Worktree setup command failed: echo second");

    await expect(
      resolveWorktree({
        branchName: "orch/abc123",
        cwd: "/repo",
        treePath: undefined,
        worktreeSetup: ["echo first", "echo second"],
        activePlanId: "def456",
        state: {},
        stateFile: "/repo/.orch/state/plan-def456.json",
        log: noop,
      }),
    ).rejects.toThrow("stdout line\nstderr line");

    expect(execFile).toHaveBeenCalledTimes(4);
    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(removeWorktree).toHaveBeenNthCalledWith(1, "/repo/.orch/trees/abc123", "/repo");
    expect(removeWorktree).toHaveBeenNthCalledWith(2, "/repo/.orch/trees/abc123", "/repo");
    expect(execFile).not.toHaveBeenCalledWith(
      expect.any(String),
      ["-lc", "echo third"],
      expect.anything(),
      expect.any(Function),
    );
    expect(saveState).not.toHaveBeenCalled();
  });

  it("falls back to forced git worktree removal when rollback hits a dirty setup tree", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(removeWorktree).mockRejectedValue(new Error("worktree is dirty"));
    const dirtyFailureImplementation: NonNullable<ExecFileImplementation> = (
      ...args: ExecFileArgs
    ) => {
      const [file, commandArgs] = args;
      if (file === "git") {
        completeExecFileCall(args[3], null, "", "");
        return {} as ReturnType<typeof execFile>;
      }

      const command = commandArgs?.[1];
      if (command === "echo dirty") {
        completeExecFileCall(args[3], null, "", "");
        return {} as ReturnType<typeof execFile>;
      }

      const error = new Error("command failed");
      completeExecFileCall(args[3], error, "stdout line", "stderr line");
      return {} as ReturnType<typeof execFile>;
    };
    mockedExecFile.mockImplementation(dirtyFailureImplementation);

    await expect(
      resolveWorktree({
        branchName: "orch/abc123",
        cwd: "/repo",
        treePath: undefined,
        worktreeSetup: ["echo dirty", "echo fail"],
        activePlanId: "abc123",
        state: {},
        stateFile: "/repo/.orch/state/plan-abc123.json",
        log: noop,
      }),
    ).rejects.toThrow("Worktree setup command failed: echo fail\nstdout line\nstderr line");

    expect(removeWorktree).toHaveBeenCalledWith("/repo/.orch/trees/abc123", "/repo");
    expect(execFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "remove", "--force", "/repo/.orch/trees/abc123"],
      expect.objectContaining({ cwd: "/repo", encoding: "utf-8" }),
      expect.any(Function),
    );
    expect(saveState).not.toHaveBeenCalled();
  });

  it("preserves the original setup error when rollback removal also fails", async () => {
    vi.mocked(createWorktree).mockResolvedValue("/repo/.orch/trees/abc123");
    vi.mocked(captureRef).mockResolvedValue("deadbeef");
    vi.mocked(removeWorktree).mockRejectedValue(new Error("cleanup failed"));
    const failingImplementation: NonNullable<ExecFileImplementation> = (
      ...args: ExecFileArgs
    ) => {
      if (args[0] === "git") {
        const error = new Error("forced cleanup failed");
        completeExecFileCall(args[3], error, "", "");
        return {} as ReturnType<typeof execFile>;
      }

      const error = new Error("command failed");
      completeExecFileCall(args[3], error, "stdout line", "stderr line");
      return {} as ReturnType<typeof execFile>;
    };
    mockedExecFile.mockImplementation(failingImplementation);

    await expect(
      resolveWorktree({
        branchName: "orch/abc123",
        cwd: "/repo",
        treePath: undefined,
        worktreeSetup: ["echo broken"],
        activePlanId: "abc123",
        state: {},
        stateFile: "/repo/.orch/state/plan-abc123.json",
        log: noop,
      }),
    ).rejects.toThrow("Worktree setup command failed: echo broken\nstdout line\nstderr line");

    expect(removeWorktree).toHaveBeenCalledWith("/repo/.orch/trees/abc123", "/repo");
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "remove", "--force", "/repo/.orch/trees/abc123"],
      expect.objectContaining({ cwd: "/repo", encoding: "utf-8" }),
      expect.any(Function),
    );
    expect(saveState).not.toHaveBeenCalled();
  });
});
