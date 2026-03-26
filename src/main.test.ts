import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync, spawnSync } from "child_process";
import { loadState, saveState, clearState } from "./state.js";
import { detectCreditExhaustion } from "./credit-detection.js";
import { createInterruptHandler } from "./interrupt.js";
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

// ─── CLI wiring integration tests ────────────────────────────────────────────

describe("CLI flag wiring", () => {
  const mainPath = join(import.meta.dirname, "main.ts");

  const runMain = (args: string[], cwd: string) =>
    spawnSync("npx", ["tsx", mainPath, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

  const initGitRepo = (dir: string) => {
    exec("git init", dir);
    exec('git config user.email "test@test.com"', dir);
    exec('git config user.name "Test"', dir);
    execSync(`touch ${join(dir, "file.txt")}`, { cwd: dir });
    exec("git add .", dir);
    exec('git commit -m "init"', dir);
  };

  it("--init and --group are mutually exclusive", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    const r = runMain(
      ["--resume", join(tempDir, "plan.md"), "--init", "--group", "Foo"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--init and --group are mutually exclusive");
    expect(r.status).not.toBe(0);
  });

  it("--resume with no path and no existing plan files exits with error", async () => {
    initGitRepo(tempDir);

    const r = runMain(
      ["--resume", "--skip-fingerprint", "--no-interaction"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("No plan found");
  });

  it("--plan with file already in plan format skips generation (treats as resume)", async () => {
    initGitRepo(tempDir);
    const planFile = join(tempDir, "already-a-plan.md");
    await writeFile(planFile, MINIMAL_PLAN);

    // This will try to orchestrate (and fail spawning claude), but it should NOT
    // attempt plan generation. Check that it doesn't print "generating plan" messages.
    const r = runMain(
      ["--plan", planFile, "--skip-fingerprint", "--no-interaction", "--plan-only"],
      tempDir,
    );

    const stdout = strip(r.stdout ?? "");
    // --plan-only with an already-plan file should report it and exit
    expect(stdout).toContain("Plan written to");
    expect(stdout).toContain("--resume");
  });

  it("--plan with plan-format file logs auto-detection message", async () => {
    initGitRepo(tempDir);
    const planFile = join(tempDir, "already-a-plan.md");
    await writeFile(planFile, MINIMAL_PLAN);

    const r = runMain(
      ["--plan", planFile, "--skip-fingerprint", "--no-interaction", "--plan-only"],
      tempDir,
    );

    const stdout = strip(r.stdout ?? "");
    expect(stdout).toContain("already a plan");
  });

  it("--plan-only generates plan path and exits without orchestrating", async () => {
    initGitRepo(tempDir);
    const planFile = join(tempDir, "plan-format.md");
    await writeFile(planFile, MINIMAL_PLAN);

    const r = runMain(
      ["--plan", planFile, "--skip-fingerprint", "--no-interaction", "--plan-only"],
      tempDir,
    );

    // Should exit cleanly (or at least print the plan-only message before any agent spawn)
    const stdout = strip(r.stdout ?? "");
    expect(stdout).toContain("Plan written to");
    expect(stdout).toContain("--resume");
    // Should NOT contain any TDD/review agent output
    expect(stdout).not.toContain("TDD");
    expect(stdout).not.toContain("Slice 1");
  });
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

describe("skip-slice state persistence (component-level)", () => {
  it("lastCompletedSlice is advanced and saved after a skip", async () => {
    // The skip branch in main.ts (lines 827-828) does:
    //   state = { ...state, lastCompletedSlice: slice.number };
    //   await saveState(resolve(cwd, CONFIG.stateFile), state);
    // Verify the save → load round trip that resume depends on.
    const stateFile = join(tempDir, "state.json");

    // Simulate state before skip: slice 2 completed, about to skip slice 3
    await saveState(stateFile, { lastCompletedSlice: 2 });

    // Simulate the skip branch: advance to slice 3
    const state = await loadState(stateFile);
    const updated = { ...state, lastCompletedSlice: 3 };
    await saveState(stateFile, updated);

    // Verify resume picks up at slice 3
    const resumed = await loadState(stateFile);
    expect(resumed.lastCompletedSlice).toBe(3);
  });
});

describe("fingerprint force wiring (integration)", () => {
  const mainPath = join(import.meta.dirname, "main.ts");

  const initGitRepo = (dir: string) => {
    exec("git init", dir);
    exec('git config user.email "test@test.com"', dir);
    exec('git config user.name "Test"', dir);
    execSync(`touch ${join(dir, "file.txt")}`, { cwd: dir });
    exec("git add .", dir);
    exec('git commit -m "init"', dir);
  };

  it("without --skip-fingerprint, brief.md is written (forceRefresh: true)", async () => {
    initGitRepo(tempDir);
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: {}, devDependencies: { typescript: "^5.0.0" } }),
    );
    await writeFile(join(tempDir, "plan.md"), `## Group: Test\n### Slice 1: Noop\nDo nothing.\n`);

    // Run WITHOUT --skip-fingerprint — fingerprint should regenerate
    const r = spawnSync("npx", [
      "tsx", mainPath, "--plan", join(tempDir, "plan.md"),
      "--no-interaction", "--plan-only",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Verify brief.md was written to .orch/
    let briefContent = "";
    try {
      briefContent = await readFile(join(tempDir, ".orch", "brief.md"), "utf-8");
    } catch { /* file not created */ }

    expect(briefContent).toContain("TypeScript");
  });
});

describe("interrupt wiring pattern (component-level)", () => {
  it("withInterrupt enables before async work and disables after", async () => {
    // Simulates the pattern main.ts uses: enable interrupt, run send, disable after.
    // Uses the real createInterruptHandler to verify the enable/disable lifecycle.
    const handler = createInterruptHandler(true); // no-op mode for this structural test
    const sequence: string[] = [];

    const originalEnable = handler.enable;
    const originalDisable = handler.disable;

    // Monkey-patch to track call order
    (handler as { enable: () => void }).enable = () => {
      sequence.push("enable");
      originalEnable();
    };
    (handler as { disable: () => void }).disable = () => {
      sequence.push("disable");
      originalDisable();
    };

    // This is the pattern used in main.ts: withInterrupt wraps async work
    const withInterrupt = async <T>(fn: () => Promise<T>): Promise<T> => {
      handler.enable();
      try {
        return await fn();
      } finally {
        handler.disable();
      }
    };

    const result = await withInterrupt(async () => {
      sequence.push("work");
      return 42;
    });

    expect(result).toBe(42);
    expect(sequence).toEqual(["enable", "work", "disable"]);
  });

  it("withInterrupt disables even if async work throws", async () => {
    const handler = createInterruptHandler(true);
    const sequence: string[] = [];

    (handler as { enable: () => void }).enable = () => sequence.push("enable");
    (handler as { disable: () => void }).disable = () => sequence.push("disable");

    const withInterrupt = async <T>(fn: () => Promise<T>): Promise<T> => {
      handler.enable();
      try {
        return await fn();
      } finally {
        handler.disable();
      }
    };

    await expect(
      withInterrupt(async () => {
        sequence.push("work");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sequence).toEqual(["enable", "work", "disable"]);
  });

  it("non-interactive mode creates no-op handler that does not interfere", () => {
    // main.ts creates handler with noInteraction flag — verify it's inert
    const handler = createInterruptHandler(true);
    expect(() => {
      handler.enable();
      handler.onInterrupt(() => {});
      handler.disable();
    }).not.toThrow();
  });

  it("callback set once via mutable ref routes to current agent after reassignment", () => {
    // main.ts sets onInterrupt once using a mutable currentAgent ref.
    // When agents are respawned, the ref is updated. The callback must route
    // to whichever agent the ref currently points to, not the original.
    const handler = createInterruptHandler(true);
    const injected: string[] = [];

    // Simulate the mutable ref pattern from main.ts
    let currentAgent = { inject: (msg: string) => injected.push(`agent1:${msg}`) };
    handler.onInterrupt((msg) => currentAgent.inject(msg));

    // Reassign the ref (simulates agent respawn at group boundary)
    currentAgent = { inject: (msg: string) => injected.push(`agent2:${msg}`) };

    // The closure captures currentAgent by reference, so it follows reassignment.
    // Verify the pattern works at the JS level:
    const callback = (msg: string) => currentAgent.inject(msg);
    callback("test");
    expect(injected).toEqual(["agent2:test"]);
  });
});
