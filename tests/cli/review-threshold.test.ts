import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { shouldReview, measureDiff } from "#infrastructure/cli/review-threshold.js";

const exec = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();

describe("shouldReview", () => {
  it("returns false when total is below threshold", () => {
    expect(shouldReview({ linesAdded: 15, linesRemoved: 14, total: 29 }, 30)).toBe(false);
  });

  it("returns true when total equals threshold", () => {
    expect(shouldReview({ linesAdded: 20, linesRemoved: 10, total: 30 }, 30)).toBe(true);
  });

  it("returns true when total exceeds threshold", () => {
    expect(shouldReview({ linesAdded: 20, linesRemoved: 11, total: 31 }, 30)).toBe(true);
  });

  it("uses default threshold of 30", () => {
    expect(shouldReview({ linesAdded: 15, linesRemoved: 14, total: 29 })).toBe(false);
    expect(shouldReview({ linesAdded: 15, linesRemoved: 15, total: 30 })).toBe(true);
  });

  it("threshold of 0 always returns true", () => {
    expect(shouldReview({ linesAdded: 0, linesRemoved: 0, total: 0 }, 0)).toBe(true);
  });

  it("returns false for zero total with default threshold", () => {
    expect(shouldReview({ linesAdded: 0, linesRemoved: 0, total: 0 })).toBe(false);
  });
});

describe("measureDiff", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "orch-threshold-"));
    exec("git init", repoDir);
    exec('git config user.email "test@test.com"', repoDir);
    exec('git config user.name "Test"', repoDir);
    await writeFile(join(repoDir, "file.txt"), "initial\n");
    exec("git add .", repoDir);
    exec('git commit -m "initial"', repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true });
  });

  it("counts committed line additions", async () => {
    const base = exec("git rev-parse HEAD", repoDir);
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    await writeFile(join(repoDir, "new.txt"), lines + "\n");
    exec("git add .", repoDir);
    exec('git commit -m "add 10 lines"', repoDir);

    const stats = await measureDiff(repoDir, base);
    expect(stats.linesAdded).toBe(10);
    expect(stats.linesRemoved).toBe(0);
    expect(stats.total).toBe(10);
  });

  it("returns zeroes when no changes exist", async () => {
    const base = exec("git rev-parse HEAD", repoDir);
    const stats = await measureDiff(repoDir, base);
    expect(stats).toEqual({ linesAdded: 0, linesRemoved: 0, total: 0 });
  });

  it("includes uncommitted working-tree changes", async () => {
    const base = exec("git rev-parse HEAD", repoDir);
    // 5 committed lines
    await writeFile(join(repoDir, "a.txt"), "a\nb\nc\nd\ne\n");
    exec("git add .", repoDir);
    exec('git commit -m "add 5"', repoDir);
    // 3 uncommitted lines
    await writeFile(join(repoDir, "b.txt"), "x\ny\nz\n");
    exec("git add b.txt", repoDir); // staged but not committed

    const stats = await measureDiff(repoDir, base);
    expect(stats.linesAdded).toBe(8); // 5 committed + 3 staged
    expect(stats.total).toBe(8);
  });

  it("includes unstaged working-tree modifications", async () => {
    const base = exec("git rev-parse HEAD", repoDir);
    // Modify existing file without staging
    await writeFile(join(repoDir, "file.txt"), "line1\nline2\nline3\n");

    const stats = await measureDiff(repoDir, base);
    // 3 added lines, 1 removed line (the original "initial\n")
    expect(stats.linesAdded).toBe(3);
    expect(stats.linesRemoved).toBe(1);
    expect(stats.total).toBe(4);
  });

  it("does not count untracked files (documents current behaviour)", async () => {
    const base = exec("git rev-parse HEAD", repoDir);
    // New file, never staged
    await writeFile(join(repoDir, "untracked.txt"), "line1\nline2\n");

    const stats = await measureDiff(repoDir, base);
    // git diff HEAD --stat doesn't include untracked files
    expect(stats).toEqual({ linesAdded: 0, linesRemoved: 0, total: 0 });
  });

  it("counts both additions and deletions in a mixed diff", async () => {
    const base = exec("git rev-parse HEAD", repoDir);
    // Add a new file (additions) and delete lines from existing (removals)
    await writeFile(join(repoDir, "new.txt"), "new1\nnew2\nnew3\n");
    await writeFile(join(repoDir, "file.txt"), ""); // remove the "initial" line
    exec("git add .", repoDir);
    exec('git commit -m "mixed additions and deletions"', repoDir);

    const stats = await measureDiff(repoDir, base);
    expect(stats.linesAdded).toBe(3);
    expect(stats.linesRemoved).toBe(1);
    expect(stats.total).toBe(4);
  });

  it("parses singular insertion correctly (1 line)", async () => {
    const base = exec("git rev-parse HEAD", repoDir);
    await writeFile(join(repoDir, "single.txt"), "one\n");
    exec("git add .", repoDir);
    exec('git commit -m "add 1 line"', repoDir);

    const stats = await measureDiff(repoDir, base);
    expect(stats.linesAdded).toBe(1);
    expect(stats.linesRemoved).toBe(0);
    expect(stats.total).toBe(1);
  });

  it("returns zeroes on git failure (safe fallback)", async () => {
    const stats = await measureDiff("/nonexistent/path", "abc123");
    expect(stats).toEqual({ linesAdded: 0, linesRemoved: 0, total: 0 });
  });
});
