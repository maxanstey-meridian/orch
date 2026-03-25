import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync, spawnSync } from "child_process";
import { loadState, saveState, clearState } from "./state.js";
import { detectCreditExhaustion } from "./credit-detection.js";
import type { AgentResult } from "./agent.js";

const exec = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();

const MINIMAL_PLAN = `## Group: Test
### Slice 1: Noop
Do nothing.
`;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-main-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe("--reset flag behavior", () => {
  it("clearState removes pre-existing state so loadState returns fresh {}", async () => {
    const stateFile = join(tempDir, "state.json");
    await saveState(stateFile, { lastCompletedSlice: 5, lastCompletedGroup: "Core" });

    // This is exactly what main.ts does at lines 489-493
    await clearState(stateFile);
    const state = await loadState(stateFile);

    expect(state).toEqual({});
  });

  it("clearState on nonexistent file does not throw, loadState returns fresh {}", async () => {
    const stateFile = join(tempDir, "state.json");
    await clearState(stateFile);
    const state = await loadState(stateFile);
    expect(state).toEqual({});
  });

  it("integration: --reset flag clears state file via the real CLI", async () => {
    // Set up git repo so assertGitRepo passes
    exec("git init", tempDir);
    exec('git config user.email "test@test.com"', tempDir);
    exec('git config user.name "Test"', tempDir);
    await writeFile(join(tempDir, "file.txt"), "init");
    exec("git add .", tempDir);
    exec('git commit -m "init"', tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    // Pre-existing state
    const stateFile = join(tempDir, ".orchestrator-state.json");
    await writeFile(stateFile, JSON.stringify({ lastCompletedSlice: 5 }));

    // Run main.ts — it will spawn claude (which may not exist), but --reset
    // runs before agent spawning. Kill after 3s to avoid hanging.
    const mainPath = join(import.meta.dirname, "main.ts");
    const r = spawnSync("npx", [
      "tsx", mainPath, "--plan", join(tempDir, "plan.md"),
      "--skip-fingerprint", "--no-interaction", "--reset",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = strip(r.stdout ?? "");

    // State clearing happens at line 489-491, before agent spawning at line 496.
    // Even if the process gets killed later, stdout should have flushed "State cleared."
    expect(stdout).toContain("State cleared.");

    // State file should be deleted
    let exists = true;
    try {
      await readFile(stateFile, "utf-8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  }, 15_000);
});

describe("exit code 2 on credit exhaustion (component-level)", () => {
  const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
    exitCode: 0,
    assistantText: "",
    resultText: "",
    needsInput: false,
    sessionId: "test",
    ...overrides,
  });

  it("detectCreditExhaustion returns signal that main.ts would use for exit(2)", () => {
    // The exitOnCreditExhaustion closure (main.ts:510-520) does:
    //   const signal = detectCreditExhaustion(result, agent.stderr);
    //   if (!signal) return;
    //   saveState(...)
    //   process.exit(2)
    //
    // We can't test process.exit(2) without spawning, but we CAN verify
    // the signal detection returns non-null (which triggers the exit path).
    const result = makeResult({ resultText: "rate limit exceeded", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).not.toBeNull();
    // If signal is non-null, main.ts exits with code 2
  });

  it("state is saved before exit(2) so resume works", async () => {
    // The closure saves state at line 514 before calling process.exit(2).
    // Verify the save → load round trip that resume depends on.
    const stateFile = join(tempDir, "state.json");
    const stateBeforeExit = { lastCompletedSlice: 3, lastCompletedGroup: "Auth" };
    await saveState(stateFile, stateBeforeExit);

    const resumed = await loadState(stateFile);
    expect(resumed).toEqual(stateBeforeExit);
  });
});

describe("mid-response logging (component-level)", () => {
  const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
    exitCode: 0,
    assistantText: "",
    resultText: "",
    needsInput: false,
    sessionId: "test",
    ...overrides,
  });

  it("mid-response signal is returned when assistantText is non-empty", () => {
    // main.ts:515-516 checks signal.kind === 'mid-response' and logs
    // "Agent was interrupted mid-response. The current slice will be re-run on resume."
    // We verify the detection returns the correct kind.
    const result = makeResult({
      assistantText: "I was working on the implementation...",
      resultText: "credit exhausted",
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).not.toBeNull();
    expect(signal!.kind).toBe("mid-response");
    // When kind is mid-response, main.ts logs the warning message
  });

  it("rejected signal (empty assistantText) does NOT trigger mid-response log path", () => {
    const result = makeResult({
      assistantText: "",
      resultText: "credit exhausted",
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).not.toBeNull();
    expect(signal!.kind).toBe("rejected");
    // kind !== 'mid-response' means the extra log line is skipped
  });
});
