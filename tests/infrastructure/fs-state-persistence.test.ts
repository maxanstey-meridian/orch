import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { FsStatePersistence } from "#infrastructure/fs-state-persistence.js";

const testPath = join(tmpdir(), `fs-state-persistence-${process.pid}.json`);

beforeEach(async () => {
  await rm(testPath, { force: true });
});

describe("FsStatePersistence", () => {
  it("load returns empty state when file does not exist", async () => {
    const adapter = new FsStatePersistence(testPath);
    const state = await adapter.load();
    expect(state).toEqual({});
  });

  it("save then load roundtrip preserves all fields", async () => {
    const adapter = new FsStatePersistence(testPath);
    const full = {
      lastCompletedSlice: 3,
      lastCompletedGroup: "Domain",
      lastSliceImplemented: 3,
      reviewBaseSha: "abc123",
      tddSession: { provider: "codex" as const, id: "tdd-sess" },
      reviewSession: { provider: "claude" as const, id: "rev-sess" },
      worktree: { path: "/tmp/wt", branch: "feat", baseSha: "def456" },
    };
    await adapter.save(full);
    const loaded = await adapter.load();
    expect(loaded).toEqual(full);
  });

  it("save overwrites previous state completely", async () => {
    const adapter = new FsStatePersistence(testPath);
    await adapter.save({ lastCompletedSlice: 1 });
    await adapter.save({ lastCompletedSlice: 5, reviewBaseSha: "abc" });
    const loaded = await adapter.load();
    expect(loaded).toEqual({ lastCompletedSlice: 5, reviewBaseSha: "abc" });
  });

  it("save replaces — fields from prior save are absent", async () => {
    const adapter = new FsStatePersistence(testPath);
    await adapter.save({
      lastCompletedSlice: 1,
      tddSession: { provider: "codex", id: "old-sess" },
    });
    await adapter.save({ reviewBaseSha: "abc" });
    const loaded = await adapter.load();
    expect(loaded).toEqual({ reviewBaseSha: "abc" });
    expect(loaded).not.toHaveProperty("tddSession");
    expect(loaded).not.toHaveProperty("lastCompletedSlice");
  });

  it("load propagates error on corrupt JSON", async () => {
    await writeFile(testPath, '{"lastCompletedSlice": "not-a-number"}');
    const adapter = new FsStatePersistence(testPath);
    await expect(adapter.load()).rejects.toThrow("Corrupt state file");
  });

  it("clear removes state, subsequent load returns empty", async () => {
    const adapter = new FsStatePersistence(testPath);
    await adapter.save({ lastCompletedSlice: 2 });
    await adapter.clear();
    const loaded = await adapter.load();
    expect(loaded).toEqual({});
  });
});
