import { describe, it, expect, beforeEach } from "vitest";
import { rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadState, saveState, clearState } from "../src/state.js";

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
});
