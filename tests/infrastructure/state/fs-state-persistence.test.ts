import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStatePersistence } from "#infrastructure/state/fs-state-persistence.js";

describe("FsStatePersistence", () => {
  let tempDir = "";
  let statePath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orch-state-persistence-"));
    statePath = join(tempDir, "state.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads an empty state when the file does not exist", async () => {
    const persistence = new FsStatePersistence(statePath);

    await expect(persistence.load()).resolves.toEqual({});
  });

  it("writes JSON with two-space indentation", async () => {
    const persistence = new FsStatePersistence(statePath);

    await persistence.save({
      lastCompletedSlice: 3,
      tddSession: { provider: "codex", id: "tdd-123" },
    });

    const raw = await readFile(statePath, "utf-8");
    expect(raw).toContain('\n  "lastCompletedSlice": 3,');
    expect(raw).toContain('\n  "tddSession": {\n    "provider": "codex",\n    "id": "tdd-123"\n  }\n');
  });

  it("round-trips saved state through the validated loader", async () => {
    const persistence = new FsStatePersistence(statePath);
    const state = {
      lastCompletedSlice: 5,
      lastCompletedGroup: "Infrastructure",
      reviewBaseSha: "abc123",
      gapSession: { provider: "claude", id: "gap-1" },
    } as const;

    await persistence.save(state);

    await expect(persistence.load()).resolves.toEqual(state);
  });

  it("rejects invalid persisted state content", async () => {
    const persistence = new FsStatePersistence(statePath);
    await writeFile(statePath, JSON.stringify({ lastCompletedSlice: "invalid" }));

    await expect(persistence.load()).rejects.toThrow("Corrupt state file");
  });

  it("clears the persisted state file", async () => {
    const persistence = new FsStatePersistence(statePath);
    await persistence.save({ lastCompletedSlice: 1 });

    await persistence.clear();

    await expect(persistence.load()).resolves.toEqual({});
  });
});
