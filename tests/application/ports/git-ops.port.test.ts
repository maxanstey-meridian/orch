import { describe, it, expect } from "vitest";
import { GitOps } from "../../../src/application/ports/git-ops.port.js";

class InMemoryGitOps extends GitOps {
  constructor(
    public head: string = "aaa111",
    public dirty: boolean = false,
    public status: string = "",
    public diffStats: { added: number; removed: number; total: number } = {
      added: 0,
      removed: 0,
      total: 0,
    },
  ) {
    super();
  }

  async captureRef(): Promise<string> {
    return this.head;
  }
  async hasChanges(since: string): Promise<boolean> {
    return this.head !== since;
  }
  async hasDirtyTree(): Promise<boolean> {
    return this.dirty;
  }
  async getStatus(): Promise<string> {
    return this.status;
  }
  async stashBackup(): Promise<boolean> {
    return this.dirty;
  }
  async measureDiff(
    _since: string,
  ): Promise<{ added: number; removed: number; total: number }> {
    return this.diffStats;
  }
}

describe("GitOps", () => {
  it("InMemoryGitOps can be instantiated and captureRef returns current SHA", async () => {
    const gitOps = new InMemoryGitOps("abc123");
    expect(gitOps).toBeInstanceOf(GitOps);
    expect(await gitOps.captureRef()).toBe("abc123");
  });

  it("hasChanges returns true when head differs from since ref", async () => {
    const gitOps = new InMemoryGitOps("abc123");
    expect(await gitOps.hasChanges("def456")).toBe(true);
  });

  it("hasChanges returns false when head equals since ref", async () => {
    const gitOps = new InMemoryGitOps("abc123");
    expect(await gitOps.hasChanges("abc123")).toBe(false);
  });

  it("hasDirtyTree returns configurable dirty state", async () => {
    const dirty = new InMemoryGitOps("aaa", true);
    expect(await dirty.hasDirtyTree()).toBe(true);

    const clean = new InMemoryGitOps("aaa", false);
    expect(await clean.hasDirtyTree()).toBe(false);
  });

  it("measureDiff returns stored diff stats", async () => {
    const stats = { added: 10, removed: 3, total: 13 };
    const gitOps = new InMemoryGitOps("aaa", false, "", stats);
    expect(await gitOps.measureDiff("some-sha")).toEqual(stats);
  });

  it("stashBackup returns true when dirty, false when clean", async () => {
    const dirty = new InMemoryGitOps("aaa", true);
    expect(await dirty.stashBackup()).toBe(true);

    const clean = new InMemoryGitOps("aaa", false);
    expect(await clean.stashBackup()).toBe(false);
  });

  it("getStatus returns stored status string", async () => {
    const gitOps = new InMemoryGitOps("aaa", false, " M src/foo.ts");
    expect(await gitOps.getStatus()).toBe(" M src/foo.ts");
  });
});
