import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsLogWriter, NullLogWriter } from "#infrastructure/log/fs-log-writer.js";

describe("FsLogWriter", () => {
  let tempDir = "";
  let logPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orch-log-writer-"));
    logPath = join(tempDir, "orch.log");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes timestamped log lines for each line of output", async () => {
    const writer = new FsLogWriter(logPath);

    writer.write("tdd", "first line\nsecond line");

    const raw = await readFile(logPath, "utf-8");
    const lines = raw.trimEnd().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.+Z\] \[tdd\] first line$/);
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.+Z\] \[tdd\] second line$/);
  });

  it("preserves empty text as a tagged blank line", async () => {
    const writer = new FsLogWriter(logPath);

    writer.write("review", "");

    await expect(readFile(logPath, "utf-8")).resolves.toMatch(
      /^\[\d{4}-\d{2}-\d{2}T.+Z\] \[review\] \n$/,
    );
  });

  it("ignores writes after close", async () => {
    const writer = new FsLogWriter(logPath);

    writer.write("verify", "before close");
    await writer.close();
    writer.write("verify", "after close");

    await expect(readFile(logPath, "utf-8")).resolves.toContain("[verify] before close");
    await expect(readFile(logPath, "utf-8")).resolves.not.toContain("[verify] after close");
  });
});

describe("NullLogWriter", () => {
  it("accepts writes and close without touching the filesystem", async () => {
    const writer = new NullLogWriter();

    expect(() => writer.write("gap", "ignored")).not.toThrow();
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
