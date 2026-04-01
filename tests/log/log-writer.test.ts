import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FsLogWriter, logPathForPlan, NullLogWriter } from "#infrastructure/log/log-writer.js";

describe("log writer", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "log-writer-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("FsLogWriter creates log file on first write", async () => {
    const logPath = join(tempDir, "plan.log");
    const writer = new FsLogWriter(logPath);

    writer.write("ORCH", "starting");
    await writer.close();

    await expect(readFile(logPath, "utf8")).resolves.toContain("starting");
  });

  it("write formats line as [timestamp] [BADGE] text", async () => {
    const logPath = join(tempDir, "plan.log");
    const writer = new FsLogWriter(logPath);

    writer.write("REVIEW", "slice complete");
    await writer.close();

    await expect(readFile(logPath, "utf8")).resolves.toMatch(
      /^\[[^\]]+\] \[REVIEW\] slice complete\n$/,
    );
  });

  it("multiple writes append to same file", async () => {
    const logPath = join(tempDir, "plan.log");
    const writer = new FsLogWriter(logPath);

    writer.write("ORCH", "slice 1");
    writer.write("TDD", "slice 2");
    await writer.close();

    const content = await readFile(logPath, "utf8");
    expect(content).toContain("[ORCH] slice 1\n");
    expect(content).toContain("[TDD] slice 2\n");
    expect(content.indexOf("[ORCH] slice 1\n")).toBeLessThan(content.indexOf("[TDD] slice 2\n"));
  });

  it("close flushes and ends stream", async () => {
    const logPath = join(tempDir, "plan.log");
    const writer = new FsLogWriter(logPath);

    await expect(writer.close()).resolves.toBeUndefined();
    expect(existsSync(logPath)).toBe(false);

    writer.write("ORCH", "done");
    await writer.close();
    await expect(writer.close()).resolves.toBeUndefined();

    await expect(readFile(logPath, "utf8")).resolves.toContain("[ORCH] done\n");
  });

  it("write creates parent directories if missing", async () => {
    const logPath = join(tempDir, "nested", "logs", "plan.log");
    const writer = new FsLogWriter(logPath);

    writer.write("ORCH", "nested");
    await writer.close();

    await expect(readFile(logPath, "utf8")).resolves.toContain("[ORCH] nested\n");
  });

  it("logPathForPlan returns correct path", () => {
    expect(logPathForPlan("/tmp/orch", "abc123")).toBe("/tmp/orch/logs/plan-abc123.log");
  });

  it("NullLogWriter.write does not throw", () => {
    const writer = new NullLogWriter();

    expect(() => writer.write("ORCH", "ignored")).not.toThrow();
  });

  it("NullLogWriter.close resolves immediately", async () => {
    const writer = new NullLogWriter();

    await expect(writer.close()).resolves.toBeUndefined();
  });

  it("timestamp format is valid ISO-8601", async () => {
    const logPath = join(tempDir, "plan.log");
    const writer = new FsLogWriter(logPath);

    writer.write("ORCH", "timed");
    await writer.close();

    const content = await readFile(logPath, "utf8");
    const timestamp = content.match(/^\[([^\]]+)\]/)?.[1];
    expect(timestamp).toBeDefined();
    if (timestamp === undefined) {
      throw new Error("Expected timestamp to be present in log line");
    }
    expect(Number.isNaN(new Date(timestamp).getTime())).toBe(false);
  });
});
