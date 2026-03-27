import { describe as _describe, it, expect, beforeEach, afterEach } from "vitest";

const describe = _describe;
const describeIntegration = process.env.INTEGRATION ? _describe : _describe.skip;
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync, spawnSync } from "child_process";
import { loadState, saveState, clearState, statePathForPlan } from "../src/state.js";
import { resolvePlanId } from "../src/plan-generator.js";

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

describeIntegration("--reset flag behavior", () => {
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

  it("--reset clears per-plan state file via --work", async () => {
    exec("git init", tempDir);
    exec('git config user.email "test@test.com"', tempDir);
    exec('git config user.name "Test"', tempDir);
    await writeFile(join(tempDir, "file.txt"), "init");
    exec("git add .", tempDir);
    exec('git commit -m "init"', tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    // Derive the plan ID the same way main.ts does for external plans
    const planPath = join(tempDir, "plan.md");
    const planId = resolvePlanId(planPath);
    const orchDir = join(tempDir, ".orch");
    const perPlanStateFile = statePathForPlan(orchDir, planId);

    // Pre-create state directory and write per-plan state
    const { mkdirSync } = await import("fs");
    mkdirSync(join(orchDir, "state"), { recursive: true });
    await saveState(perPlanStateFile, { lastCompletedSlice: 7 });

    // Verify state file exists before reset
    const stateBefore = await loadState(perPlanStateFile);
    expect(stateBefore.lastCompletedSlice).toBe(7);

    const mainPath = join(import.meta.dirname, "../src/main.ts");
    spawnSync("npx", [
      "tsx", mainPath, "--work", planPath,
      "--skip-fingerprint", "--no-interaction", "--reset",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Per-plan state file should be cleared
    const stateAfter = await loadState(perPlanStateFile);
    expect(stateAfter).toEqual({});
  }, 15_000);
});

describe("SHA-256 fallback plan ID derivation", () => {
  it("produces a deterministic 6-char hex ID from the same path", () => {
    const id1 = resolvePlanId("/repo/plan.md");
    const id2 = resolvePlanId("/repo/plan.md");
    expect(id1).toMatch(/^[0-9a-f]{6}$/);
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different paths", () => {
    const idA = resolvePlanId("/repo/plan-a.md");
    const idB = resolvePlanId("/repo/plan-b.md");
    expect(idA).not.toBe(idB);
  });

  it("derived ID maps to a valid statePathForPlan path", () => {
    const id = resolvePlanId("/repo/plan.md");
    const statePath = statePathForPlan("/repo/.orch", id);
    expect(statePath).toMatch(/\.orch\/state\/plan-[0-9a-f]{6}\.json$/);
  });
});

// ─── CLI wiring integration tests ────────────────────────────────────────────

describeIntegration("CLI flag wiring", () => {
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
      ["--work", join(tempDir, "plan.md"), "--init", "--group", "Foo"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--init and --group are mutually exclusive");
    expect(r.status).not.toBe(0);
  });

  it("--plan + --work errors with clear message", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "inventory.md"), "# Feature Inventory\n- Auth\n");

    const r = runMain(
      ["--plan", join(tempDir, "inventory.md"), "--work"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--plan");
    expect(stderr).toContain("--work");
    expect(r.status).not.toBe(0);
  });

  it("--plan-only is no longer recognized and exits with error", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    const r = runMain(
      ["--plan", join(tempDir, "plan.md"), "--skip-fingerprint", "--no-interaction", "--plan-only"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--plan-only");
    expect(stderr).toContain("no longer supported");
    expect(r.status).not.toBe(0);
  });

  it("--plan-only as sole flag (without --plan) exits with error", async () => {
    initGitRepo(tempDir);

    const r = runMain(["--plan-only"], tempDir);

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--plan-only");
    expect(stderr).toContain("no longer supported");
    expect(r.status).not.toBe(0);
  });

  it("no-flags error mentions --plan and --work", async () => {
    initGitRepo(tempDir);

    const r = runMain([], tempDir);

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--plan");
    expect(stderr).toContain("--work");
    expect(r.status).not.toBe(0);
  });

  it("--work .orch/plan-a1b2c3.md uses scoped state path", async () => {
    initGitRepo(tempDir);
    const { mkdirSync } = await import("fs");
    mkdirSync(join(tempDir, ".orch"), { recursive: true });
    await writeFile(
      join(tempDir, ".orch", "plan-a1b2c3.md"),
      MINIMAL_PLAN,
    );

    // --work with a plan-<id>.md path should derive state at .orch/state/plan-a1b2c3.json
    // Process will attempt orchestration (and hang/crash without agent), but the
    // state dir + plan ID derivation happen before orchestration starts.
    spawnSync("npx", [
      "tsx", mainPath,
      "--work", join(tempDir, ".orch", "plan-a1b2c3.md"),
      "--skip-fingerprint", "--no-interaction",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // State directory should have been created with the correct plan ID
    const { existsSync } = await import("fs");
    const stateDir = join(tempDir, ".orch", "state");
    expect(existsSync(stateDir)).toBe(true);
  }, 15_000);

  it("--work without a path argument errors immediately", async () => {
    initGitRepo(tempDir);

    const r = runMain(
      ["--work", "--skip-fingerprint", "--no-interaction"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--work requires a plan path");
    expect(r.status).not.toBe(0);
  });

  it("--work plan.md (non-standard name) creates scoped state with fresh ID", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    // --work with a non-standard plan name should:
    // 1. Generate a plan ID from the path
    // 2. Copy/symlink to .orch/plan-<id>.md
    // 3. Create state at .orch/state/plan-<id>.json
    spawnSync("npx", [
      "tsx", mainPath,
      "--work", join(tempDir, "plan.md"),
      "--skip-fingerprint", "--no-interaction",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const { existsSync, readdirSync } = await import("fs");
    // .orch directory should exist with a plan-<id>.md symlink/copy
    const orchDir = join(tempDir, ".orch");
    expect(existsSync(orchDir)).toBe(true);
    const orchFiles = readdirSync(orchDir);
    const planCopy = orchFiles.find((f: string) => /^plan-[0-9a-f]{6}\.md$/.test(f));
    expect(planCopy).toBeDefined();

    // State directory should also exist
    expect(existsSync(join(orchDir, "state"))).toBe(true);
  }, 15_000);

  it("--work plan.md does not touch unrelated plan files in .orch", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    // Create an unrelated plan file
    const { mkdirSync } = await import("fs");
    mkdirSync(join(tempDir, ".orch"), { recursive: true });
    await writeFile(join(tempDir, ".orch", "plan-999aaa.md"), "# other plan — do not overwrite");

    spawnSync("npx", [
      "tsx", mainPath,
      "--work", join(tempDir, "plan.md"),
      "--skip-fingerprint", "--no-interaction",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // The unrelated plan file should NOT have been overwritten
    const otherContent = await readFile(join(tempDir, ".orch", "plan-999aaa.md"), "utf-8");
    expect(otherContent).toContain("other plan — do not overwrite");

    // A new plan-<hash>.md should have been created for plan.md
    const { readdirSync } = await import("fs");
    const orchFiles = readdirSync(join(tempDir, ".orch"));
    const planFiles = orchFiles.filter((f: string) => /^plan-[0-9a-f]{6}\.md$/.test(f));
    expect(planFiles.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("--work + --group Auth skips to that group", async () => {
    initGitRepo(tempDir);
    const multiGroupPlan = `## Group: Setup\n### Slice 1: Init\nDo setup.\n\n## Group: Auth\n### Slice 2: Login\nDo login.\n`;
    const { mkdirSync } = await import("fs");
    mkdirSync(join(tempDir, ".orch"), { recursive: true });
    await writeFile(join(tempDir, ".orch", "plan-abc123.md"), multiGroupPlan);

    const r = spawnSync("npx", [
      "tsx", mainPath,
      "--work", join(tempDir, ".orch", "plan-abc123.md"),
      "--skip-fingerprint", "--no-interaction",
      "--group", "Auth",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const combined = strip((r.stdout ?? "") + (r.stderr ?? ""));
    // Should show the Auth group, not the Setup group
    expect(combined).toContain("Auth");
    // Should skip Setup — the first group section header should not appear in output
    expect(combined).not.toContain("Group: Setup — Slice 1");
  }, 15_000);

  // ── Gap-coverage tests ──────────────────────────────────────────────────

  it("--work as the only flag (no path, no other args) errors", async () => {
    initGitRepo(tempDir);

    const r = runMain(["--work"], tempDir);

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--work requires a plan path");
    expect(r.status).not.toBe(0);
  });

  it("--resume is no longer recognized and exits with error", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    const r = runMain(
      ["--resume", join(tempDir, "plan.md")],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--resume");
    expect(stderr).toContain("no longer supported");
    expect(r.status).not.toBe(0);
  });

  it("--work plan.md --reset clears per-plan state for the hash-derived ID", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    // Derive the same ID main.ts would use for this path
    const planPath = join(tempDir, "plan.md");
    const expectedId = resolvePlanId(planPath);
    const orchDir = join(tempDir, ".orch");
    const perPlanState = statePathForPlan(orchDir, expectedId);

    // Pre-create state
    const { mkdirSync } = await import("fs");
    mkdirSync(join(orchDir, "state"), { recursive: true });
    await saveState(perPlanState, { lastCompletedSlice: 5 });

    // Verify state exists
    const before = await loadState(perPlanState);
    expect(before.lastCompletedSlice).toBe(5);

    spawnSync("npx", [
      "tsx", mainPath,
      "--work", planPath,
      "--skip-fingerprint", "--no-interaction", "--reset",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // State should be cleared
    const after = await loadState(perPlanState);
    expect(after).toEqual({});
  }, 15_000);

  it("--work plan.md --auto starts without inter-group prompts", async () => {
    initGitRepo(tempDir);
    const multiGroupPlan = `## Group: A\n### Slice 1: S1\nDo A.\n\n## Group: B\n### Slice 2: S2\nDo B.\n`;
    await writeFile(join(tempDir, "plan.md"), multiGroupPlan);

    const r = spawnSync("npx", [
      "tsx", mainPath,
      "--work", join(tempDir, "plan.md"),
      "--skip-fingerprint", "--no-interaction", "--auto",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const combined = strip((r.stdout ?? "") + (r.stderr ?? ""));
    // Should start orchestration (both groups visible, no "Continue?" prompt)
    expect(combined).toContain("Group: A");
    // Should not contain any fallback or argument errors
    expect(combined).not.toContain("--work requires");
    expect(combined).not.toContain("No plan found");
  }, 15_000);

  it("--plan with nonexistent inventory file exits with error", async () => {
    initGitRepo(tempDir);

    const r = runMain(
      ["--plan", join(tempDir, "nonexistent-inventory.md"), "--skip-fingerprint", "--no-interaction"],
      tempDir,
    );

    expect(r.status).not.toBe(0);
  });

  it("--work with nonexistent plan file exits with error", async () => {
    initGitRepo(tempDir);

    const r = spawnSync("npx", [
      "tsx", mainPath,
      "--work", join(tempDir, "nonexistent-plan.md"),
      "--skip-fingerprint", "--no-interaction",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    expect(r.status).not.toBe(0);
  }, 15_000);

  it("--work with dash-prefixed path is treated as missing argument", async () => {
    initGitRepo(tempDir);

    const r = runMain(
      ["--work", "-plan.md"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--work requires a plan path");
    expect(r.status).not.toBe(0);
  });

  it("--resume without path also exits with error (not recognized)", async () => {
    initGitRepo(tempDir);

    const r = runMain(
      ["--resume"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("--resume");
    expect(stderr).toContain("no longer supported");
    expect(r.status).not.toBe(0);
  });

  it("--resume in non-git directory fails with git repo error (assertGitRepo runs first)", async () => {
    // Documenting current behavior: assertGitRepo runs before flag checks,
    // so deprecated flags in a non-git dir get "not a git repository" instead
    // of the deprecation message.
    const r = runMain(["--resume"], tempDir);

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("git");
    expect(r.status).not.toBe(0);
  });

  it("--plan-only in non-git directory fails with git repo error (assertGitRepo runs first)", async () => {
    const r = runMain(["--plan-only"], tempDir);

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("git");
    expect(r.status).not.toBe(0);
  });

  it("--review-threshold with non-numeric value exits with error", async () => {
    initGitRepo(tempDir);

    const r = runMain(
      ["--work", join(tempDir, "plan.md"), "--review-threshold", "abc"],
      tempDir,
    );

    const stderr = strip(r.stderr ?? "");
    expect(stderr).toContain("Invalid --review-threshold value");
    expect(stderr).toContain("abc");
    expect(r.status).not.toBe(0);
  });

  it("--group as last flag with no value is silently ignored (starts from group 0)", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    // --group at the end with no value → getArg returns undefined → groupFilter is undefined
    // → startIdx = 0 → all groups run from the beginning (no error)
    const r = spawnSync("npx", [
      "tsx", mainPath,
      "--work", join(tempDir, "plan.md"),
      "--skip-fingerprint", "--no-interaction",
      "--group",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderr = strip(r.stderr ?? "");
    // Should NOT contain the "No group" error — undefined groupFilter is falsy
    expect(stderr).not.toContain("No group");
  }, 15_000);

});

describeIntegration("legacy cleanup", () => {
  it("no references to .orchestrator-state.json remain in source files", () => {
    const { execSync } = require("child_process");
    const result = execSync(
      'grep -r ".orchestrator-state.json" src/ --include="*.ts" -l || true',
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });
});

describeIntegration(".orch/ directory structure", () => {
  it("state files live under .orch/state/plan-<id>.json", () => {
    const statePath = statePathForPlan("/repo/.orch", "a1b2c3");
    expect(statePath).toBe("/repo/.orch/state/plan-a1b2c3.json");
  });

  it("no global stateFile config exists (only per-plan state)", () => {
    const { execSync } = require("child_process");
    const result = execSync(
      'grep -r "CONFIG.stateFile\\|stateFile:" src/ --include="*.ts" -l || true',
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("--work plan.md creates plan-<id>.md and state/ dir with matching ID layout", async () => {
    const { mkdtemp, rm, writeFile: wf } = await import("fs/promises");
    const { existsSync, readdirSync } = await import("fs");
    const dir = await mkdtemp(join(tmpdir(), "orch-struct-"));
    try {
      execSync("git init", { cwd: dir });
      execSync('git config user.email "t@t.com"', { cwd: dir });
      execSync('git config user.name "T"', { cwd: dir });
      await wf(join(dir, "f.txt"), "x");
      execSync("git add . && git commit -m init", { cwd: dir });
      await wf(join(dir, "plan.md"), MINIMAL_PLAN);

      // Pre-seed per-plan state so the state file exists after --work
      const planPath = join(dir, "plan.md");
      const expectedId = resolvePlanId(planPath);
      const orchDir = join(dir, ".orch");
      const { mkdirSync } = await import("fs");
      mkdirSync(join(orchDir, "state"), { recursive: true });
      await saveState(statePathForPlan(orchDir, expectedId), { lastCompletedSlice: 0 });

      const mainPath = join(import.meta.dirname, "../src/main.ts");
      spawnSync("npx", [
        "tsx", mainPath,
        "--work", planPath,
        "--skip-fingerprint", "--no-interaction",
      ], { cwd: dir, encoding: "utf-8", timeout: 8_000, stdio: ["pipe", "pipe", "pipe"] });

      expect(existsSync(orchDir)).toBe(true);

      // plan-<id>.md should exist (copied from plan.md)
      const orchFiles = readdirSync(orchDir);
      const planFile = orchFiles.find((f: string) => /^plan-[0-9a-f]{6}\.md$/.test(f));
      expect(planFile).toBeDefined();

      // Extract ID from plan file and verify it matches the state file
      const planId = planFile!.match(/plan-([0-9a-f]{6})\.md/)![1];
      expect(planId).toBe(expectedId);

      // state/ directory should contain plan-<same-id>.json
      const stateDir = join(orchDir, "state");
      expect(existsSync(stateDir)).toBe(true);
      const stateFiles = readdirSync(stateDir);
      expect(stateFiles).toContain(`plan-${planId}.json`);
    } finally {
      await rm(dir, { recursive: true });
    }
  }, 15_000);

  it("no references to currentPlanId remain in source", () => {
    const { execSync } = require("child_process");
    const result = execSync(
      'grep -r "currentPlanId" src/ --include="*.ts" -l || true',
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });
});




describeIntegration("fingerprint force wiring (integration)", () => {
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
      "--no-interaction",
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

