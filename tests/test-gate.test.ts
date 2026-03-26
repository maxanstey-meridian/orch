import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runTestGate } from "../src/test-gate.js";

const makeScript = async (dir: string, name: string, body: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-tg-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe("runTestGate", () => {
  it("passes when test command exits successfully", async () => {
    const script = await makeScript(tempDir, "pass.sh", 'echo "all tests passed"');
    const result = await runTestGate({ testCommand: script });
    expect(result.passed).toBe(true);
    expect(result.output).toBe("");
  });

  it("fails and captures output when test command exits non-zero", async () => {
    const script = await makeScript(
      tempDir,
      "fail.sh",
      'echo "FAIL: 2 tests failed"; echo "details here" >&2; exit 1',
    );
    const result = await runTestGate({ testCommand: script });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("FAIL: 2 tests failed");
    expect(result.output).toContain("details here");
  });

  it("passes when no test command is configured (gate is permissive)", async () => {
    const result = await runTestGate({});
    expect(result.passed).toBe(true);
    expect(result.output).toBe("");
  });

  it("passes when test command is empty string (gate is permissive)", async () => {
    const result = await runTestGate({ testCommand: "" });
    expect(result.passed).toBe(true);
    expect(result.output).toBe("");
  });

  it("returns passed false with empty output when test script exits non-zero but writes nothing", async () => {
    const script = await makeScript(tempDir, "silent-fail.sh", "exit 1");
    const result = await runTestGate({ testCommand: script });
    expect(result.passed).toBe(false);
    expect(result.output).toBe("");
  });

  it("fails with error output when command is not found", async () => {
    const result = await runTestGate({ testCommand: "/nonexistent/test-runner" });
    expect(result.passed).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  });
});
