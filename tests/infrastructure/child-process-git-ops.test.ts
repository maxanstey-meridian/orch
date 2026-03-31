import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/infrastructure/git/git.js", () => ({
  captureRef: vi.fn().mockResolvedValue("abc123"),
  hasChanges: vi.fn().mockResolvedValue(true),
  hasDirtyTree: vi.fn().mockResolvedValue(false),
  getStatus: vi.fn().mockResolvedValue("M file.ts"),
  getDiff: vi.fn().mockResolvedValue("diff --git a/file.ts b/file.ts"),
  stashBackup: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../src/infrastructure/cli/review-threshold.js", () => ({
  measureDiff: vi.fn().mockResolvedValue({ linesAdded: 10, linesRemoved: 3, total: 13 }),
}));

import {
  captureRef,
  hasChanges,
  hasDirtyTree,
  getStatus,
  getDiff,
  stashBackup,
} from "#infrastructure/git/git.js";
import { measureDiff } from "#infrastructure/cli/review-threshold.js";
import { shouldReview } from "#domain/review.js";
import type { Mock } from "vitest";
import { ChildProcessGitOps } from "#infrastructure/child-process-git-ops.js";

describe("ChildProcessGitOps", () => {
  const adapter = new ChildProcessGitOps("/test/repo");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("delegates git.ts functions with bound cwd", () => {
    it("captureRef delegates with cwd", async () => {
      const result = await adapter.captureRef();
      expect(result).toBe("abc123");
      expect(captureRef).toHaveBeenCalledWith("/test/repo");
    });

    it("hasChanges delegates with cwd and since", async () => {
      const result = await adapter.hasChanges("def456");
      expect(result).toBe(true);
      expect(hasChanges).toHaveBeenCalledWith("/test/repo", "def456");
    });

    it("hasDirtyTree delegates with cwd", async () => {
      const result = await adapter.hasDirtyTree();
      expect(result).toBe(false);
      expect(hasDirtyTree).toHaveBeenCalledWith("/test/repo");
    });

    it("getStatus delegates with cwd", async () => {
      const result = await adapter.getStatus();
      expect(result).toBe("M file.ts");
      expect(getStatus).toHaveBeenCalledWith("/test/repo");
    });

    it("getDiff delegates with cwd and since", async () => {
      const result = await adapter.getDiff("def456");
      expect(result).toBe("diff --git a/file.ts b/file.ts");
      expect(getDiff).toHaveBeenCalledWith("/test/repo", "def456");
    });

    it("stashBackup delegates with cwd", async () => {
      const result = await adapter.stashBackup();
      expect(result).toBe(true);
      expect(stashBackup).toHaveBeenCalledWith("/test/repo");
    });
  });

  describe("measureDiff", () => {
    it("maps linesAdded→added, linesRemoved→removed, total→total", async () => {
      const result = await adapter.measureDiff("abc123");
      expect(result).toEqual({ added: 10, removed: 3, total: 13 });
      expect(measureDiff).toHaveBeenCalledWith("/test/repo", "abc123");
    });
  });
});

describe("shouldReview compatibility with port diff shape", () => {
  it("accepts port measureDiff shape at threshold", () => {
    expect(shouldReview({ added: 5, removed: 5, total: 10 }, 10)).toBe(true);
  });

  it("accepts port measureDiff shape below threshold", () => {
    expect(shouldReview({ added: 2, removed: 1, total: 3 }, 10)).toBe(false);
  });
});
