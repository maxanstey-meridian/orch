import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync, spawnSync } from "child_process";
import { loadState, saveState, clearState } from "../src/state.js";
import { detectCreditExhaustion } from "../src/credit-detection.js";
import { buildCommitSweepPrompt, commitSweep } from "../src/main.js";
import type { AgentResult, AgentProcess } from "../src/agent.js";

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

  it("--reset with external plan and no currentPlanId does not use global state file", async () => {
    // Set up git repo
    exec("git init", tempDir);
    exec('git config user.email "test@test.com"', tempDir);
    exec('git config user.name "Test"', tempDir);
    await writeFile(join(tempDir, "file.txt"), "init");
    exec("git add .", tempDir);
    exec('git commit -m "init"', tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    // Write global state WITHOUT currentPlanId but with some data
    const globalStateFile = join(tempDir, ".orchestrator-state.json");
    await saveState(globalStateFile, { lastCompletedSlice: 3 });

    const mainPath = join(import.meta.dirname, "../src/main.ts");
    spawnSync("npx", [
      "tsx", mainPath, "--plan", join(tempDir, "plan.md"),
      "--skip-fingerprint", "--no-interaction", "--reset",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Global state file must survive — --reset should not touch it
    const globalState = await loadState(globalStateFile);
    expect(globalState.lastCompletedSlice).toBe(3);
  }, 15_000);
});

// ─── CLI wiring integration tests ────────────────────────────────────────────

describe("CLI flag wiring", () => {
  const mainPath = join(import.meta.dirname, "../src/main.ts");

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

  it("--reset clears per-plan state file, not global state", async () => {
    initGitRepo(tempDir);

    const orchDir = join(tempDir, ".orch");
    const stateDir = join(orchDir, "state");
    execSync(`mkdir -p "${stateDir}"`);

    // Write plan file with ID
    await writeFile(join(orchDir, "plan-abc123.md"), MINIMAL_PLAN);

    // Write global state with currentPlanId
    const globalStateFile = join(tempDir, ".orchestrator-state.json");
    await saveState(globalStateFile, { currentPlanId: "abc123" });

    // Write per-plan state with progress
    const planStateFile = join(stateDir, "plan-abc123.json");
    await saveState(planStateFile, { lastCompletedSlice: 5 });

    // --reset --resume should clear per-plan state
    const r = runMain(
      ["--resume", "--skip-fingerprint", "--no-interaction", "--reset"],
      tempDir,
    );

    const stdout = strip(r.stdout ?? "");
    expect(stdout).toContain("State cleared");

    // Per-plan state should be cleared
    const planState = await loadState(planStateFile);
    expect(planState).toEqual({});

    // Global state should still have currentPlanId
    const globalState = await loadState(globalStateFile);
    expect(globalState.currentPlanId).toBe("abc123");
  }, 15_000);

  it("--reset succeeds when .orch/state/ directory does not exist yet", async () => {
    initGitRepo(tempDir);

    const orchDir = join(tempDir, ".orch");
    execSync(`mkdir -p "${orchDir}"`);

    // Write plan file but do NOT create state/ subdirectory
    await writeFile(join(orchDir, "plan-def456.md"), MINIMAL_PLAN);

    // Write global state with currentPlanId pointing to this plan
    const globalStateFile = join(tempDir, ".orchestrator-state.json");
    await saveState(globalStateFile, { currentPlanId: "def456" });

    const r = runMain(
      ["--resume", "--skip-fingerprint", "--no-interaction", "--reset"],
      tempDir,
    );

    const stdout = strip(r.stdout ?? "");
    expect(stdout).toContain("State cleared");
    // Should not crash — exit due to plan processing, not state error
    expect(r.stderr ?? "").not.toContain("ENOENT");
  }, 15_000);

  it("--resume finds plan-<id>.md via currentPlanId in state", async () => {
    initGitRepo(tempDir);

    // Write a plan file with the new naming scheme
    const orchDir = join(tempDir, ".orch");
    execSync(`mkdir -p "${orchDir}"`);
    await writeFile(join(orchDir, "plan-abc123.md"), MINIMAL_PLAN);

    // Write state with currentPlanId
    const stateFile = join(tempDir, ".orchestrator-state.json");
    await saveState(stateFile, { currentPlanId: "abc123" });

    // --resume without explicit path should find it via state
    const r = runMain(
      ["--resume", "--skip-fingerprint", "--no-interaction"],
      tempDir,
    );

    // If plan resolution fails, process exits immediately with status 1
    // and "No plan found" in stderr. If it succeeds, it proceeds to
    // orchestration (and eventually times out or crashes spawning agents).
    // A non-1 exit status or a SIGTERM signal means it got past plan resolution.
    const stderr = strip(r.stderr ?? "");
    expect(stderr).not.toContain("No plan found");
    expect(r.status).not.toBe(1);
  }, 15_000);

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
  const mainPath = join(import.meta.dirname, "../src/main.ts");

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


describe("buildCommitSweepPrompt", () => {
  it("includes the group name and key instruction text", () => {
    const prompt = buildCommitSweepPrompt("Authentication");
    expect(prompt).toContain("Authentication");
    expect(prompt).toContain("uncommitted changes");
    expect(prompt).toContain("commit");
  });
});

describe("buildCommitSweepPrompt edge cases", () => {
  it("handles empty group name without crashing", () => {
    const prompt = buildCommitSweepPrompt("");
    expect(prompt).toContain("uncommitted changes");
    // Should still produce a valid string, not crash
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("handles group name with special characters", () => {
    const prompt = buildCommitSweepPrompt('Auth "OAuth2" & <SSO>');
    expect(prompt).toContain('Auth "OAuth2" & <SSO>');
    expect(prompt).toContain("uncommitted changes");
  });
});

describe("commitSweep", () => {
  const fakeResult = (overrides?: Partial<AgentResult>): AgentResult => ({
    exitCode: 0, assistantText: "", resultText: "", needsInput: false, sessionId: "test",
    ...overrides,
  });

  const fakeAgent = (overrides?: Partial<AgentProcess>): AgentProcess => ({
    send: async () => fakeResult(),
    sendQuiet: async () => "",
    inject: () => {},
    kill: () => {},
    alive: true,
    sessionId: "test",
    style: { label: "TDD", color: "", badge: "" },
    stderr: "",
    ...overrides,
  });

  const makeFakeAgent = () => {
    const calls: { prompt: string }[] = [];
    const agent = fakeAgent({
      send: async (prompt: string) => {
        calls.push({ prompt });
        return fakeResult();
      },
    });
    return { agent, calls };
  };

  const noopStreamer = Object.assign((_t: string) => {}, { flush: () => {} });
  const noopExitCheck = async () => {};
  const passThrough = async <T>(_agent: AgentProcess, fn: () => Promise<T>) => fn();

  it("skips when working tree is clean (no agent call)", async () => {
    const { agent, calls } = makeFakeAgent();
    const logs: string[] = [];

    await commitSweep({
      groupName: "Auth",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => false,
      log: (...args: unknown[]) => logs.push(String(args[0])),
    });

    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.includes("uncommitted"))).toBe(false);
  });

  it("calls agent.send with commit sweep prompt when tree is dirty", async () => {
    const { agent, calls } = makeFakeAgent();
    const logs: string[] = [];

    await commitSweep({
      groupName: "Auth",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: (...args: unknown[]) => logs.push(String(args[0])),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("Auth");
    expect(calls[0].prompt).toContain("uncommitted changes");
    expect(logs.some((l) => l.includes("uncommitted changes detected"))).toBe(true);
  });

  it("logs success when agent exits 0, failure when non-zero", async () => {
    const logs: string[] = [];
    const makeAgent = (exitCode: number) => fakeAgent({
      send: async () => fakeResult({ exitCode }),
    });

    // Exit 0 → success log
    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent: makeAgent(0),
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: (...args: unknown[]) => logs.push(String(args[0])),
    });
    expect(logs.some((l) => l.includes("commit sweep complete"))).toBe(true);

    logs.length = 0;

    // Exit 1 → failure log
    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent: makeAgent(1),
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: (...args: unknown[]) => logs.push(String(args[0])),
    });
    expect(logs.some((l) => l.includes("uncommitted changes may remain"))).toBe(true);
  });

  it("calls exitOnCreditExhaustion with the agent result", async () => {
    const creditChecks: AgentResult[] = [];
    const { agent } = makeFakeAgent();

    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: async (result: AgentResult) => { creditChecks.push(result); },
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: () => {},
    });

    expect(creditChecks).toHaveLength(1);
    expect(creditChecks[0].exitCode).toBe(0);
  });

  it("wraps agent.send through withInterrupt", async () => {
    const { agent } = makeFakeAgent();
    let interruptCalled = false;

    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: async (_agent, fn) => { interruptCalled = true; return fn(); },
      hasDirtyTree: async () => true,
      log: () => {},
    });

    expect(interruptCalled).toBe(true);
  });

  it("completes agent send and credit check before returning (internal sequencing)", async () => {
    const sequence: string[] = [];

    const agent = fakeAgent({
      send: async () => {
        sequence.push("agent.send");
        return fakeResult();
      },
    });

    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: async () => { sequence.push("creditCheck"); },
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: () => {},
    });

    // After commitSweep returns, both agent.send and creditCheck must have run.
    // This guarantees that any code after `await commitSweep(...)` (like saveState)
    // executes after the sweep is fully complete.
    sequence.push("returned");
    expect(sequence).toEqual(["agent.send", "creditCheck", "returned"]);
  });

  it("calls followUpIfNeeded when agent response has needsInput", async () => {
    const followUpCalls: AgentResult[] = [];
    const agent = fakeAgent({
      send: async () => fakeResult({ needsInput: true }),
    });

    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: () => {},
      followUpIfNeeded: async (result) => { followUpCalls.push(result); return result; },
    });

    expect(followUpCalls).toHaveLength(1);
    expect(followUpCalls[0].needsInput).toBe(true);
  });

  it("does not call followUpIfNeeded when needsInput is false", async () => {
    const { agent } = makeFakeAgent(); // returns needsInput: false
    const followUpCalls: AgentResult[] = [];

    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: () => {},
      followUpIfNeeded: async (result) => { followUpCalls.push(result); return result; },
    });

    expect(followUpCalls).toHaveLength(0);
  });

  it("agent failure during sweep logs warning but does not throw", async () => {
    const failAgent = fakeAgent({
      send: async () => fakeResult({ exitCode: 1 }),
    });

    const logs: string[] = [];

    // Should not throw
    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent: failAgent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: (...args: unknown[]) => logs.push(String(args[0])),
    });

    expect(logs.some((l) => l.includes("uncommitted changes may remain"))).toBe(true);
    expect(logs.some((l) => l.includes("exit 1"))).toBe(true);
  });

  it("skips with warning when agent is dead (alive=false)", async () => {
    const deadAgent = fakeAgent({
      send: async () => { throw new Error("should not be called"); },
      alive: false,
    });

    const logs: string[] = [];

    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent: deadAgent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: (...args: unknown[]) => logs.push(String(args[0])),
    });

    // Should not throw, should log a warning
    expect(logs.some((l) => l.includes("agent") && l.includes("not alive"))).toBe(true);
  });

  it("resume scenario: fires on dirty tree regardless of slice completion state", async () => {
    // Simulates the Ctrl+C resume case: all slices already completed
    // (lastCompletedSlice set), but lastCompletedGroup is unset — so the
    // group loop re-enters and commitSweep fires if tree is dirty.
    // commitSweep itself is slice-state-agnostic — it only checks hasDirtyTree.
    const { agent, calls } = makeFakeAgent();
    const logs: string[] = [];

    // Even though this simulates "after all slices completed", the sweep fires
    // because hasDirtyTree returns true — independent of slice state.
    await commitSweep({
      groupName: "Auth",
      cwd: "/fake",
      agent,
      makeStreamer: () => noopStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: (...args: unknown[]) => logs.push(String(args[0])),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("Auth");
    expect(logs.some((l) => l.includes("uncommitted changes detected"))).toBe(true);
    expect(logs.some((l) => l.includes("commit sweep complete"))).toBe(true);
  });

  it("propagates error when hasDirtyTree throws", async () => {
    const { agent } = makeFakeAgent();

    await expect(
      commitSweep({
        groupName: "G",
        cwd: "/fake",
        agent,
        makeStreamer: () => noopStreamer,
        exitOnCreditExhaustion: noopExitCheck,
        withInterrupt: passThrough,
        hasDirtyTree: async () => { throw new Error("git not found"); },
        log: () => {},
      }),
    ).rejects.toThrow("git not found");
  });

  it("propagates error when agent.send throws", async () => {
    const throwingAgent = fakeAgent({
      send: async () => { throw new Error("connection lost"); },
    });

    await expect(
      commitSweep({
        groupName: "G",
        cwd: "/fake",
        agent: throwingAgent,
        makeStreamer: () => noopStreamer,
        exitOnCreditExhaustion: noopExitCheck,
        withInterrupt: passThrough,
        hasDirtyTree: async () => true,
        log: () => {},
      }),
    ).rejects.toThrow("connection lost");
  });

  it("calls flush on the streamer after agent.send completes", async () => {
    const { agent } = makeFakeAgent();
    let flushed = false;
    const trackingStreamer = Object.assign((_t: string) => {}, { flush: () => { flushed = true; } });

    await commitSweep({
      groupName: "G",
      cwd: "/fake",
      agent,
      makeStreamer: () => trackingStreamer,
      exitOnCreditExhaustion: noopExitCheck,
      withInterrupt: passThrough,
      hasDirtyTree: async () => true,
      log: () => {},
    });

    expect(flushed).toBe(true);
  });

  it("does not log success/failure when exitOnCreditExhaustion throws", async () => {
    const { agent } = makeFakeAgent();
    const logs: string[] = [];

    await expect(
      commitSweep({
        groupName: "G",
        cwd: "/fake",
        agent,
        makeStreamer: () => noopStreamer,
        exitOnCreditExhaustion: async () => { throw new Error("credit exhausted"); },
        withInterrupt: passThrough,
        hasDirtyTree: async () => true,
        log: (...args: unknown[]) => logs.push(String(args[0])),
      }),
    ).rejects.toThrow("credit exhausted");

    // The entry log fires, but success/failure log should NOT have been reached
    expect(logs.some((l) => l.includes("uncommitted changes detected"))).toBe(true);
    expect(logs.some((l) => l.includes("commit sweep complete"))).toBe(false);
    expect(logs.some((l) => l.includes("uncommitted changes may remain"))).toBe(false);
  });
});
