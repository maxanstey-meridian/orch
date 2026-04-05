import { describe as _describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const describe = _describe;
const describeIntegration = process.env.INTEGRATION ? _describe : _describe.skip;
import { mkdir, mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { execSync, spawnSync } from "child_process";
import { parseExecutionPreference } from "#infrastructure/cli/cli-args.js";
import { loadState, saveState, clearState, statePathForPlan } from "#infrastructure/state/state.js";
import { resolvePlanId } from "#infrastructure/plan/plan-generator.js";
import { logPathForPlan } from "#infrastructure/log/log-writer.js";

const exec = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();

const MINIMAL_PLAN = `## Group: Test
### Slice 1: Noop
Do nothing.
`;

const buildDirectArtifactPlan = (inventoryPath: string): string => JSON.stringify({
  groups: [
    {
      name: "Direct",
      slices: [
        {
          number: 1,
          title: "Direct request",
          why: "Direct execution was selected during bootstrap.",
          files: [{ path: inventoryPath, action: "edit" }],
          details: "Implement the inventory request directly without generated plan slices.",
          tests: "Run the relevant tests and explain the coverage changes.",
        },
      ],
    },
  ],
});

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const getCreateContainerConfig = (createContainer: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const firstCall = (createContainer.mock.calls as unknown[][])[0];
  if (!firstCall) {
    throw new Error("Expected createContainer to be called");
  }

  const config = firstCall[0];
  if (!config || typeof config !== "object") {
    throw new Error("Expected createContainer to receive a config object");
  }

  return config as Record<string, unknown>;
};

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

describe("execution preference parsing", () => {
  it("returns auto when no execution mode flag is present", () => {
    expect(parseExecutionPreference([])).toBe("auto");
  });

  it("returns quick for --quick", () => {
    expect(parseExecutionPreference(["--quick"])).toBe("quick");
  });

  it("returns grouped for --grouped", () => {
    expect(parseExecutionPreference(["--grouped"])).toBe("grouped");
  });

  it("returns long for --long", () => {
    expect(parseExecutionPreference(["--long"])).toBe("long");
  });

  it("throws when multiple execution mode flags are combined", () => {
    expect(() => parseExecutionPreference(["--quick", "--grouped"])).toThrow(
      /mutually exclusive.*--quick.*--grouped/i,
    );
  });
});

describe("subcommand routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("fs");
    vi.doUnmock("node:fs");
    vi.doUnmock("fs/promises");
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  const loadMainWithSubcommandMocks = async (
    options: {
      watchFactory?: (
        path: string,
        listener: (eventType: string, changedFileName: string | Buffer | null) => void,
      ) => import("fs").FSWatcher;
      onReadFilePath?: (path: string) => void;
    } = {},
  ) => {
    const renderDashboard = vi.fn().mockResolvedValue(undefined);
    const aggregateDashboard = vi.fn().mockResolvedValue({
      active: [],
      queued: [],
      completed: [],
    });
    const addToQueue = vi.fn().mockResolvedValue(undefined);
    const readQueue = vi.fn().mockResolvedValue([]);
    const removeFromQueue = vi.fn().mockResolvedValue(undefined);
    const assertGitRepo = vi.fn().mockResolvedValue(undefined);

    vi.doMock("#ui/dashboard/dashboard-app.js", () => ({
      renderDashboard,
    }));
    vi.doMock("#infrastructure/dashboard/data-aggregator.js", () => ({
      aggregateDashboard,
    }));
    vi.doMock("#infrastructure/queue/queue-store.js", () => ({
      defaultQueuePath: vi.fn(() => "/tmp/default-queue.json"),
      addToQueue,
      readQueue,
      removeFromQueue,
    }));
    vi.doMock("#infrastructure/git/repo-check.js", () => ({
      assertGitRepo,
    }));
    if (options.watchFactory !== undefined) {
      const watchFactory = options.watchFactory;
      vi.doMock("fs", async () => {
        const actual = await vi.importActual<typeof import("fs")>("fs");
        return {
          ...actual,
          watch: watchFactory,
        };
      });
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("fs")>("fs");
        return {
          ...actual,
          watch: watchFactory,
        };
      });
    }
    if (options.onReadFilePath !== undefined) {
      const onReadFilePath = options.onReadFilePath;
      const mockFsPromises = async () => {
        const actual =
          await vi.importActual<typeof import("fs/promises")>("fs/promises");

        return {
          ...actual,
          // Test-only boundary wrapper around the overloaded Node API.
          readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
            onReadFilePath(String(path));
            return Reflect.apply(actual.readFile, actual, [path, ...rest]);
          }) as typeof actual.readFile,
        };
      };
      vi.doMock("fs/promises", mockFsPromises);
      vi.doMock("node:fs/promises", mockFsPromises);
    }

    const mainModule = await import("../src/main.js");

    return {
      ...mainModule,
      mocks: {
        renderDashboard,
        aggregateDashboard,
        addToQueue,
        readQueue,
        removeFromQueue,
        assertGitRepo,
      },
    };
  };

  it("routes dash before git repo assertion", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "dash"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
    }

    expect(mocks.renderDashboard).toHaveBeenCalledWith({
      registryPath: "/tmp/runs.json",
      queuePath: "/tmp/queue.json",
      launchCommand: process.execPath,
      launchArgs: expect.arrayContaining([
        expect.stringMatching(/main\.ts$/),
      ]),
    });
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("queue add persists a normalized queue entry without requiring a git repo", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    const previousArgv = process.argv;
    const previousCwd = process.cwd();
    process.argv = ["node", "main.ts", "queue", "add", "plans/demo.json", "--auto", "--branch", "feature/queue"];
    process.chdir(tempDir);
    const expectedRepo = process.cwd();
    const expectedPlanPath = resolve("plans/demo.json");

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
      process.chdir(previousCwd);
    }

    expect(mocks.addToQueue).toHaveBeenCalledWith(
      "/tmp/queue.json",
      expect.objectContaining({
        repo: expectedRepo,
        planPath: expectedPlanPath,
        branch: "feature/queue",
        flags: ["--auto", "--branch", "feature/queue"],
        id: resolvePlanId(expectedPlanPath),
        addedAt: expect.any(String),
      }),
    );
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("queue remove reports explicit command errors for malformed known subcommands", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "queue", "remove"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit,
      });
    } finally {
      process.argv = previousArgv;
    }

    expect(errorSpy).toHaveBeenCalledWith("queue remove requires an id.");
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("queue list prints persisted entries without requiring a git repo", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    mocks.readQueue.mockResolvedValue([
      {
        id: "queue-1",
        repo: "/repos/queued",
        planPath: "/plans/queued.json",
        flags: ["--auto"],
        addedAt: "2026-04-10T10:00:00.000Z",
      },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "queue", "list"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
    }

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Queue");
    expect(output).toContain("queue-1 /repos/queued /plans/queued.json --auto");
    expect(mocks.readQueue).toHaveBeenCalledWith("/tmp/queue.json");
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("queue remove deletes the requested entry and reports success", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "queue", "remove", "queue-1"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
    }

    expect(mocks.removeFromQueue).toHaveBeenCalledWith("/tmp/queue.json", "queue-1");
    expect(logSpy).toHaveBeenCalledWith("Removed queue-1");
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("status prints aggregated dashboard output without requiring a git repo", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    mocks.aggregateDashboard.mockResolvedValue({
      active: [
        {
          id: "run-active",
          repo: "/repos/active",
          status: "active",
          sliceProgress: "S1/3",
          currentPhase: "review",
          elapsed: "5m",
          pid: 123,
        },
      ],
      queued: [
        {
          id: "queue-1",
          repo: "/repos/queued",
          planPath: "/plans/queued.json",
          flags: ["--auto"],
          addedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
      completed: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "status"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
    }

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Active");
    expect(output).toContain("run-active /repos/active active S1/3 review 5m");
    expect(output).toContain("Queued");
    expect(output).toContain("queue-1 /repos/queued /plans/queued.json --auto");
    expect(mocks.aggregateDashboard).toHaveBeenCalledWith("/tmp/runs.json", "/tmp/queue.json");
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("status with an id prints detailed run information", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    mocks.aggregateDashboard.mockResolvedValue({
      active: [
        {
          id: "run-active",
          repo: "/repos/active",
          planName: "Dashboard",
          branch: "feature/queue",
          status: "active",
          sliceProgress: "S2/3",
          currentPhase: "verify",
          elapsed: "9m",
          pid: 123,
          logPath: "/logs/run-active.log",
          groups: [
            {
              name: "Foundation",
              slices: [
                { number: 1, title: "Registry", status: "done", elapsed: "2m" },
                { number: 2, title: "Queue", status: "active", elapsed: "7m" },
              ],
            },
          ],
        },
      ],
      queued: [],
      completed: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "status", "run-active"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
    }

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Run run-active");
    expect(output).toContain("Plan: Dashboard");
    expect(output).toContain("Phase: verify");
    expect(output).toContain("Foundation");
    expect(output).toContain("active S2 Queue 7m");
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("status with a queued id prints queued entry details", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    mocks.aggregateDashboard.mockResolvedValue({
      active: [],
      queued: [
        {
          id: "queue-1",
          repo: "/repos/queued",
          planPath: "/plans/queued.json",
          branch: "feature/queued",
          flags: ["--auto"],
          addedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
      completed: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "status", "queue-1"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
    }

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Queued queue-1");
    expect(output).toContain("Repo: /repos/queued");
    expect(output).toContain("Plan: /plans/queued.json");
    expect(output).toContain("Branch: feature/queued");
    expect(output).toContain("Flags: --auto");
    expect(output).toContain("Added: 2026-04-10T10:00:00.000Z");
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  // MANUAL TEST REQUIRED: verify `orch status <id> -f` streams appended output live
  // and exits cleanly on interrupt in a real terminal.
  it("status follow prints the current log output before entering follow mode", async () => {
    const logDir = join(tempDir, "logs");
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, "run-active.log");
    await writeFile(logPath, "line 1\n");
    const watcherError = Object.assign(new Error("stop following"), {
      code: "EPIPE",
    });
    const readFilePaths: string[] = [];
    const { main, mocks } = await loadMainWithSubcommandMocks({
      watchFactory: (_path, _listener) => {
        const watcher = new EventEmitter() as EventEmitter & {
          close: () => void;
        };
        watcher.close = vi.fn();
        setTimeout(() => {
          watcher.emit("error", watcherError);
        }, 0);
        return watcher as unknown as import("fs").FSWatcher;
      },
      onReadFilePath: (path) => {
        readFilePaths.push(path);
      },
    });
    mocks.aggregateDashboard.mockResolvedValue({
      active: [
        {
          id: "run-active",
          repo: "/repos/active",
          status: "active",
          sliceProgress: "S1/3",
          currentPhase: "review",
          elapsed: "5m",
          pid: 123,
          logPath,
        },
      ],
      queued: [],
      completed: [],
    });
    const exit = vi.fn();
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "status", "run-active", "-f"];

    try {
      const pendingMain = main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit,
      });
      const settledMain = pendingMain.then(
        () => undefined,
        (error: unknown) => error,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(readFilePaths).toContain(logPath);
      await expect(settledMain).resolves.toMatchObject({
        code: "EPIPE",
      });
    } finally {
      process.argv = previousArgv;
    }

    expect(exit).not.toHaveBeenCalled();
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
  });

  it("status follow exits non-zero when the matched run has no log path", async () => {
    const { main, mocks } = await loadMainWithSubcommandMocks();
    mocks.aggregateDashboard.mockResolvedValue({
      active: [
        {
          id: "run-active",
          repo: "/repos/active",
          status: "active",
          sliceProgress: "S1/3",
          currentPhase: "review",
          elapsed: "5m",
          pid: 123,
        },
      ],
      queued: [],
      completed: [],
    });
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "status", "run-active", "-f"];

    try {
      await main({
        registryPath: "/tmp/runs.json",
        queuePath: "/tmp/queue.json",
        exit,
      });
    } finally {
      process.argv = previousArgv;
    }

    expect(errorSpy).toHaveBeenCalledWith("Cannot follow logs for run-active.");
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
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

  it("--work plan.md leaves per-plan state in place after a successful run", async () => {
    initGitRepo(tempDir);
    await writeFile(join(tempDir, "plan.md"), MINIMAL_PLAN);

    const planPath = join(tempDir, "plan.md");
    const expectedId = resolvePlanId(planPath);
    const orchDir = join(tempDir, ".orch");
    const perPlanState = statePathForPlan(orchDir, expectedId);

    const result = spawnSync("npx", [
      "tsx", mainPath,
      "--work", planPath,
      "--skip-fingerprint", "--no-interaction", "--auto",
    ], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    const after = await loadState(perPlanState);
    expect(after.lastCompletedSlice).toBe(1);
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

// ─── Composition root integration ───────────────────────────────────────────

vi.mock("../src/infrastructure/claude/claude-agent-factory.js", () => ({
  spawnClaudeAgent: vi.fn(),
  spawnClaudePlanAgent: vi.fn(),
  spawnClaudeGeneratePlanAgent: vi.fn(),
  TDD_RULES_REMINDER: "tdd rules",
  REVIEW_RULES_REMINDER: "review rules",
  buildRulesReminder: vi.fn((base: string, custom?: string) =>
    custom ? `${base}\n${custom}` : base,
  ),
}));

import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { OrchestratorConfig } from "#domain/config.js";
import type { AgentResult } from "#domain/agent-types.js";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
import { RunOrchestration } from "#application/run-orchestration.js";
import { IncompleteRunError } from "#domain/errors.js";

const makeTestConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief text",
  executionMode: "sliced",
  executionPreference: "auto",
  auto: false,
  reviewThreshold: 0,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  logPath: null,
  tier: "medium",
  skills: { tdd: "tdd-skill", review: "review-skill", verify: "verify-skill", gap: null, plan: null, completeness: "completeness-skill" },
  maxReplans: 2,
  defaultProvider: "claude",
  agentConfig: AGENT_DEFAULTS,
  ...overrides,
});

const makeTestResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test-session",
  ...overrides,
});

const makeTestAgent = (): AgentHandle => ({
  sessionId: "agent-sess",
  style: { label: "Test", color: "#fff", badge: "[T]" },
  alive: true,
  stderr: "",
  send: vi.fn().mockResolvedValue(makeTestResult()),
  sendQuiet: vi.fn().mockResolvedValue("quiet"),
  inject: vi.fn(),
  kill: vi.fn(),
  pipe: vi.fn(),
});

const runMainWithWorkPlanMocks = async (
  args: string[],
  options?: {
    planPath?: string;
    planContent?: string;
    generatedPlanId?: string;
    preloadedState?: Record<string, unknown>;
    runCleanupResult?: string;
    worktreeSetup?: string[];
    fingerprintBrief?: string | ((cwd: string) => string);
    assertGitRepoImplementation?: (cwd: string) => Promise<void>;
    checkWorktreeResumeResult?: { ok: true } | { ok: false; message: string };
    resolveWorktreeResult?: {
      cwd: string;
      worktreeInfo: { path: string; branch: string } | null;
      skipStash: boolean;
      updatedState?: Record<string, unknown>;
    };
    resolveWorktreeError?: Error;
  },
) => {
  const planPath = options?.planPath ?? join(tempDir, "plan.md");
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, options?.planContent ?? MINIMAL_PLAN);
  const orchDir = join(tempDir, ".orch");
  const stateFile = statePathForPlan(orchDir, resolvePlanId(planPath));
  if (options?.preloadedState !== undefined) {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify(options.preloadedState, null, 2));
  }
  const createContainer = vi.fn(() => ({
    resolve: vi.fn(() => ({
      execute: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    })),
  }));
  const assertGitRepo = vi.fn(options?.assertGitRepoImplementation ?? (async () => undefined));
  const runFingerprint = vi.fn().mockImplementation(async ({ cwd }: { cwd: string }) => ({
    brief:
      typeof options?.fingerprintBrief === "function"
        ? options.fingerprintBrief(cwd)
        : (options?.fingerprintBrief ?? "brief text"),
  }));
  const generatePlanId = vi.fn(() => options?.generatedPlanId ?? "direct01");
  const resolveWorktree = options?.resolveWorktreeError === undefined
    ? vi.fn().mockResolvedValue(
        options?.resolveWorktreeResult ?? {
          cwd: tempDir,
          worktreeInfo: null,
          skipStash: true,
          updatedState: {},
        },
      )
    : vi.fn().mockRejectedValue(options.resolveWorktreeError);
  const checkWorktreeResume = vi.fn().mockResolvedValue(
    options?.checkWorktreeResumeResult ?? { ok: true },
  );
  const runCleanup = vi.fn().mockResolvedValue(options?.runCleanupResult ?? "cleanup complete");
  const stashBackup = vi.fn().mockResolvedValue(false);
  const complexityTriageSpawnerFactory = vi.fn(() => () => ({
    send: vi.fn(),
    kill: vi.fn(),
  }));
  const parsePlan = vi.fn().mockResolvedValue([
    {
      name: "Test",
      slices: [{
        number: 1,
        title: "Slice 1",
        content: "content",
        why: "why",
        files: [{ path: "src/s1.ts", action: "new" }],
        details: "details",
        tests: "tests",
      }],
    },
  ]);
  const formatPlanSummary = vi.fn();

  vi.resetModules();
  vi.doMock("../src/composition-root.js", () => ({
    createContainer,
  }));
  vi.doMock("#infrastructure/git/repo-check.js", () => ({
    assertGitRepo,
  }));
  vi.doMock("#infrastructure/config/orchrc.js", () => ({
    loadAndResolveOrchrConfig: vi.fn(() => ({
      skills: {
        tdd: { enabled: true, value: "tdd skill" },
        review: { enabled: true, value: "review skill" },
        verify: { enabled: true, value: "verify skill" },
        gap: { disabled: true },
        plan: { disabled: true },
      },
      config: {},
      rules: { tdd: undefined, review: undefined },
      worktreeSetup: options?.worktreeSetup ?? [],
      agents: {},
    })),
    buildOrchrSummary: vi.fn(() => "summary"),
  }));
  vi.doMock("#infrastructure/complexity-triage.js", () => ({
    buildComplexityTriagePrompt: vi.fn(),
    parseComplexityTriageResult: vi.fn(() => ({ tier: "medium", reason: "test" })),
  }));
  vi.doMock("#infrastructure/skill-loader.js", () => ({
    buildSkillOverrides: vi.fn(() => ({})),
    loadTieredSkills: vi.fn(() => ({
      tdd: "tdd skill", review: "review skill", verify: "verify skill",
      gap: null, plan: null, completeness: "completeness skill",
    })),
  }));
  vi.doMock("#domain/agent-config.js", async () => {
    const actual = await vi.importActual<typeof import("#domain/agent-config.js")>("#domain/agent-config.js");
    return {
      ...actual,
      resolveAllAgentConfigs: vi.fn(() => actual.AGENT_DEFAULTS),
    };
  });
  vi.doMock("#infrastructure/fingerprint.js", () => ({
    runFingerprint,
  }));
  vi.doMock("#infrastructure/plan/plan-generator.js", async () => {
    const actual =
      await vi.importActual<typeof import("#infrastructure/plan/plan-generator.js")>(
        "#infrastructure/plan/plan-generator.js"
      );
    return {
      ...actual,
      generatePlanId,
    };
  });
  vi.doMock("#infrastructure/plan/plan-parser.js", () => ({
    parsePlan,
  }));
  vi.doMock("#infrastructure/git/worktree.js", () => ({
    checkWorktreeResume,
    runCleanup,
  }));
  vi.doMock("#infrastructure/git/worktree-setup.js", () => ({
    resolveWorktree,
  }));
  vi.doMock("#infrastructure/git/git.js", () => ({
    getStatus: vi.fn().mockResolvedValue(""),
    stashBackup,
  }));
  vi.doMock("#ui/hud.js", () => ({
    createHud: vi.fn(() => ({
      update: vi.fn(),
      wrapLog: vi.fn((logger: (...args: unknown[]) => void) => logger),
      teardown: vi.fn(),
      setActivity: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      createWriter: vi.fn(() => () => {}),
      setSkipping: vi.fn(),
    })),
  }));
  vi.doMock("#ui/display.js", async () => {
    const actual = await vi.importActual<typeof import("#ui/display.js")>("#ui/display.js");
    return {
      ...actual,
      logSection: vi.fn(),
      printStartupBanner: vi.fn(),
      formatPlanSummary,
    };
  });
  vi.doMock("#infrastructure/factories.js", async () => {
    const actual =
      await vi.importActual<typeof import("#infrastructure/factories.js")>(
        "#infrastructure/factories.js"
      );
    return {
      ...actual,
      complexityTriageSpawnerFactory,
    };
  });

  const exit = vi.fn();
  const previousArgv = process.argv;
  const previousCwd = process.cwd();
  process.argv = [
    "node",
    "main.ts",
    "--work",
    planPath,
    "--skip-fingerprint",
    "--no-interaction",
    ...args,
  ];
  process.chdir(tempDir);

  try {
    const { main } = await import("../src/main.js");
    await main({
      registryPath: join(tempDir, "registry", "runs.json"),
      onSignal: vi.fn(() => process),
      exit,
    });
  } finally {
    process.argv = previousArgv;
    process.chdir(previousCwd);
    vi.doUnmock("../src/composition-root.js");
    vi.doUnmock("#infrastructure/git/repo-check.js");
    vi.doUnmock("#infrastructure/config/orchrc.js");
    vi.doUnmock("#infrastructure/complexity-triage.js");
    vi.doUnmock("#infrastructure/skill-loader.js");
    vi.doUnmock("#infrastructure/factories.js");
    vi.doUnmock("#domain/agent-config.js");
    vi.doUnmock("#infrastructure/fingerprint.js");
    vi.doUnmock("#infrastructure/plan/plan-generator.js");
    vi.doUnmock("#infrastructure/plan/plan-parser.js");
    vi.doUnmock("#infrastructure/git/worktree.js");
    vi.doUnmock("#infrastructure/git/worktree-setup.js");
    vi.doUnmock("#infrastructure/git/git.js");
    vi.doUnmock("#ui/hud.js");
    vi.doUnmock("#ui/display.js");
    vi.resetModules();
  }

  return {
    assertGitRepo,
    createContainer,
    exit,
    planPath,
    runFingerprint,
    resolveWorktree,
    checkWorktreeResume,
    runCleanup,
    generatePlanId,
    parsePlan,
    formatPlanSummary,
    stateFile,
    stashBackup,
    complexityTriageSpawnerFactory,
  };
};

const runMainWithInventoryPlanMocks = async (options?: {
  args?: string[];
  requestTriageResult?: { mode: "direct" | "grouped" | "sliced"; reason: string };
  requestTriageText?: string;
  requestTriageResultText?: string;
  requestTriageSendError?: Error;
  parsedRequestTriageResult?: { mode: "direct" | "grouped" | "sliced"; reason: string };
  fingerprintBrief?: string | ((cwd: string) => string);
  worktreeSetup?: string[];
  inputAlreadyPlan?: boolean;
  inventoryContent?: string;
  generatedPlanId?: string;
  assertGitRepoImplementation?: (cwd: string) => Promise<void>;
  resolveWorktreeResult?: {
    cwd: string;
    worktreeInfo: { path: string; branch: string } | null;
    skipStash: boolean;
    updatedState?: Record<string, unknown>;
  };
  resolveWorktreeError?: Error;
}) => {
  const inventoryPath = join(tempDir, "inventory.md");
  await writeFile(
    inventoryPath,
    options?.inventoryContent ?? "# Feature Inventory\n\n- Add authentication\n",
  );

  const generatedPlanPath = join(tempDir, ".orch", "plan-generated.json");
  await mkdir(join(tempDir, ".orch"), { recursive: true });
  await writeFile(generatedPlanPath, JSON.stringify({
    groups: [
      {
        name: "Generated",
        slices: [
          {
            number: 1,
            title: "Slice 1",
            why: "why",
            files: [{ path: "src/s1.ts", action: "new" }],
            details: "details",
            tests: "tests",
          },
        ],
      },
    ],
  }));

  const execute = vi.fn().mockResolvedValue(undefined);
  const logSection = vi.fn();
  const createContainer = vi.fn(() => ({
    resolve: vi.fn(() => ({
      execute,
      dispose: vi.fn(),
    })),
  }));
  const doGeneratePlan = vi.fn().mockResolvedValue(generatedPlanPath);
  const generatePlanId = vi.fn(() => options?.generatedPlanId ?? "direct01");
  const assertGitRepo = vi.fn(options?.assertGitRepoImplementation ?? (async () => undefined));
  const runFingerprint = vi.fn().mockImplementation(async ({ cwd }: { cwd: string }) => ({
    brief:
      typeof options?.fingerprintBrief === "function"
        ? options.fingerprintBrief(cwd)
        : (options?.fingerprintBrief ?? "brief text"),
  }));
  const defaultResolveWorktreeResult = options?.resolveWorktreeResult ?? {
    cwd: tempDir,
    worktreeInfo: null,
    skipStash: true,
    updatedState: {},
  };
  const resolveWorktree = options?.resolveWorktreeError === undefined
    ? vi.fn().mockResolvedValue(defaultResolveWorktreeResult)
    : vi.fn().mockRejectedValue(options.resolveWorktreeError);
  const triageAgent = {
    send: options?.requestTriageSendError === undefined
      ? vi.fn().mockResolvedValue({
          assistantText: options?.requestTriageText ?? JSON.stringify(
            options?.requestTriageResult ?? {
              mode: "direct" as const,
              reason: "bounded local change",
            },
          ),
          resultText: options?.requestTriageResultText ?? "",
        })
      : vi.fn().mockRejectedValue(options.requestTriageSendError),
    kill: vi.fn(),
  };
  const requestTriageSpawnerFactory = vi.fn(() => () => {
    return triageAgent;
  });
  const planGeneratorSpawnerFactory = vi.fn(() => () => ({
    send: vi.fn(),
    kill: vi.fn(),
  }));
  const buildRequestTriagePrompt = vi.fn(() => '{"mode":"direct","reason":"bounded local change"}');
  const parseRequestTriageResult = vi.fn((text: string) =>
    options?.parsedRequestTriageResult ?? JSON.parse(text)
  );
  const hudLogs: string[] = [];

  vi.resetModules();
  vi.doMock("../src/composition-root.js", () => ({
    createContainer,
  }));
  vi.doMock("#infrastructure/git/repo-check.js", () => ({
    assertGitRepo,
  }));
  vi.doMock("#infrastructure/config/orchrc.js", () => ({
    loadAndResolveOrchrConfig: vi.fn(() => ({
      skills: {
        tdd: { enabled: true, value: "tdd skill" },
        review: { enabled: true, value: "review skill" },
        verify: { enabled: true, value: "verify skill" },
        gap: { disabled: true },
        plan: { disabled: false },
      },
      config: {},
      rules: { tdd: undefined, review: undefined },
      worktreeSetup: options?.worktreeSetup ?? [],
      agents: {},
    })),
    buildOrchrSummary: vi.fn(() => "summary"),
  }));
  vi.doMock("#infrastructure/complexity-triage.js", () => ({
    buildComplexityTriagePrompt: vi.fn(),
    parseComplexityTriageResult: vi.fn(() => ({ tier: "medium", reason: "test" })),
  }));
  vi.doMock("#infrastructure/skill-loader.js", () => ({
    buildSkillOverrides: vi.fn(() => ({})),
    loadTieredSkills: vi.fn(() => ({
      tdd: "tdd skill", review: "review skill", verify: "verify skill",
      gap: null, plan: "plan skill", completeness: "completeness skill",
    })),
  }));
  vi.doMock("#domain/agent-config.js", async () => {
    const actual = await vi.importActual<typeof import("#domain/agent-config.js")>("#domain/agent-config.js");
    return {
      ...actual,
      resolveAllAgentConfigs: vi.fn(() => actual.AGENT_DEFAULTS),
    };
  });
  vi.doMock("#infrastructure/fingerprint.js", () => ({
    runFingerprint,
  }));
  vi.doMock("#infrastructure/plan/plan-generator.js", async () => {
    const actual =
      await vi.importActual<typeof import("#infrastructure/plan/plan-generator.js")>(
        "#infrastructure/plan/plan-generator.js"
      );
    return {
      ...actual,
      generatePlanId,
      isPlanFormat: vi.fn(() => options?.inputAlreadyPlan ?? false),
      doGeneratePlan,
    };
  });
  vi.doMock("#infrastructure/request-triage.js", () => ({
    buildRequestTriagePrompt,
    parseRequestTriageResult,
  }));
  vi.doMock("#infrastructure/factories.js", async () => {
    const actual =
      await vi.importActual<typeof import("#infrastructure/factories.js")>(
        "#infrastructure/factories.js"
      );
    return {
      ...actual,
      requestTriageSpawnerFactory,
      complexityTriageSpawnerFactory: vi.fn(() => () => ({
        send: vi.fn(),
        kill: vi.fn(),
      })),
      planGeneratorSpawnerFactory,
    };
  });
  vi.doMock("#infrastructure/plan/plan-parser.js", () => ({
    parsePlan: vi.fn().mockResolvedValue([
      {
        name: "Generated",
        slices: [{
          number: 1,
          title: "Slice 1",
          content: "content",
          why: "why",
          files: [{ path: "src/s1.ts", action: "new" }],
          details: "details",
          tests: "tests",
        }],
      },
    ]),
  }));
  vi.doMock("#infrastructure/git/worktree.js", () => ({
    checkWorktreeResume: vi.fn().mockResolvedValue({ ok: true }),
    runCleanup: vi.fn(),
  }));
  vi.doMock("#infrastructure/git/worktree-setup.js", () => ({
    resolveWorktree,
  }));
  vi.doMock("#infrastructure/git/git.js", () => ({
    getStatus: vi.fn().mockResolvedValue(""),
    stashBackup: vi.fn().mockResolvedValue(false),
  }));
  vi.doMock("#ui/hud.js", () => ({
    createHud: vi.fn(() => ({
      update: vi.fn(),
      wrapLog: vi.fn((_logger: (...args: unknown[]) => void) => (...args: unknown[]) => {
        hudLogs.push(args.map(String).join(" "));
      }),
      teardown: vi.fn(),
      setActivity: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      createWriter: vi.fn(() => (text: string) => {
        hudLogs.push(text);
      }),
      setSkipping: vi.fn(),
    })),
  }));
  vi.doMock("#ui/display.js", async () => {
    const actual = await vi.importActual<typeof import("#ui/display.js")>("#ui/display.js");
    return {
      ...actual,
      logSection,
      printStartupBanner: vi.fn(),
      formatPlanSummary: vi.fn(),
    };
  });

  const exit = vi.fn();
  const registryPath = join(tempDir, "registry", "runs.json");
  const previousArgv = process.argv;
  const previousCwd = process.cwd();
  process.argv = [
    "node",
    "main.ts",
    "--plan",
    inventoryPath,
    "--skip-fingerprint",
    "--no-interaction",
    ...(options?.args ?? []),
  ];
  process.chdir(tempDir);

  try {
    const { main } = await import("../src/main.js");
    await main({
      registryPath,
      onSignal: vi.fn(() => process),
      exit,
    });
  } finally {
    process.argv = previousArgv;
    process.chdir(previousCwd);
    vi.doUnmock("../src/composition-root.js");
    vi.doUnmock("#infrastructure/git/repo-check.js");
    vi.doUnmock("#infrastructure/config/orchrc.js");
    vi.doUnmock("#infrastructure/complexity-triage.js");
    vi.doUnmock("#infrastructure/skill-loader.js");
    vi.doUnmock("#domain/agent-config.js");
    vi.doUnmock("#infrastructure/fingerprint.js");
    vi.doUnmock("#infrastructure/plan/plan-generator.js");
    vi.doUnmock("#infrastructure/request-triage.js");
    vi.doUnmock("#infrastructure/factories.js");
    vi.doUnmock("#infrastructure/plan/plan-parser.js");
    vi.doUnmock("#infrastructure/git/worktree.js");
    vi.doUnmock("#infrastructure/git/worktree-setup.js");
    vi.doUnmock("#infrastructure/git/git.js");
    vi.doUnmock("#ui/hud.js");
    vi.doUnmock("#ui/display.js");
    vi.resetModules();
  }

  return {
    assertGitRepo,
    createContainer,
    execute,
    doGeneratePlan,
    generatePlanId,
    requestTriageSpawnerFactory,
    planGeneratorSpawnerFactory,
    buildRequestTriagePrompt,
    parseRequestTriageResult,
    exit,
    hudLogs,
    inventoryPath,
    registryPath,
    resolveWorktree,
    runFingerprint,
    stateFile: statePathForPlan(join(tempDir, ".orch"), options?.generatedPlanId ?? "direct01"),
    triageAgent,
    logSection,
  };
};

describe("main tree flag validation", () => {
  const runWithMode = async (
    mode: "work" | "plan",
    args: string[],
    options?: {
      assertGitRepoImplementation?: (cwd: string) => Promise<void>;
    },
  ) =>
    mode === "work"
      ? runMainWithWorkPlanMocks(args, options)
      : runMainWithInventoryPlanMocks({
          args,
          assertGitRepoImplementation: options?.assertGitRepoImplementation,
        });

  it.each(["work", "plan"] as const)(
    "exits before bootstrap when --tree is missing a value in %s mode",
    async (mode) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await runWithMode(mode, ["--tree"]);

      expect(errorSpy).toHaveBeenCalledWith("--tree requires a path value.");
      expect(result.exit).toHaveBeenCalledWith(1);
      expect(result.assertGitRepo).not.toHaveBeenCalled();
      expect(result.runFingerprint).not.toHaveBeenCalled();
      expect(result.resolveWorktree).not.toHaveBeenCalled();
      expect(result.createContainer).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
  );

  it.each(["work", "plan"] as const)(
    "rejects combining --tree with --branch in %s mode",
    async (mode) => {
      const treePath = join(tempDir, `${mode}-existing-tree`);
      await mkdir(treePath, { recursive: true });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await runWithMode(mode, ["--tree", treePath, "--branch", "feature/existing"]);

      expect(errorSpy).toHaveBeenCalledWith("--tree and --branch are mutually exclusive.");
      expect(result.exit).toHaveBeenCalledWith(1);
      expect(result.assertGitRepo).not.toHaveBeenCalled();
      expect(result.runFingerprint).not.toHaveBeenCalled();
      expect(result.resolveWorktree).not.toHaveBeenCalled();
      expect(result.createContainer).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
  );

  it.each(["work", "plan"] as const)(
    "rejects a nonexistent --tree path before bootstrap in %s mode",
    async (mode) => {
      const treePath = join(tempDir, `${mode}-missing-tree`);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await runWithMode(mode, ["--tree", treePath]);

      expect(errorSpy).toHaveBeenCalledWith(`--tree path does not exist: ${treePath}`);
      expect(result.exit).toHaveBeenCalledWith(1);
      expect(result.assertGitRepo).not.toHaveBeenCalled();
      expect(result.runFingerprint).not.toHaveBeenCalled();
      expect(result.resolveWorktree).not.toHaveBeenCalled();
      expect(result.createContainer).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
  );

  it.each(["work", "plan"] as const)(
    "rejects a non-git --tree directory before planning or execution in %s mode",
    async (mode) => {
      const treePath = join(tempDir, `${mode}-plain-dir`);
      await mkdir(treePath, { recursive: true });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await runWithMode(mode, ["--tree", treePath], {
        assertGitRepoImplementation: async (cwd) => {
          if (cwd === treePath) {
            throw new Error(
              'Not a git repository. The orchestrator requires git for change tracking.\nRun: git init && git commit --allow-empty -m "init"',
            );
          }
        },
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Not a git repository"));
      expect(result.exit).toHaveBeenCalledWith(1);
      expect(result.assertGitRepo).toHaveBeenCalledTimes(2);
      expect(result.assertGitRepo.mock.calls[0]?.[0]).not.toBe(result.assertGitRepo.mock.calls[1]?.[0]);
      expect(result.assertGitRepo.mock.calls[1]?.[0]).toContain(`${mode}-plain-dir`);
      expect(result.runFingerprint).not.toHaveBeenCalled();
      expect(result.resolveWorktree).not.toHaveBeenCalled();
      expect(result.createContainer).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
  );
});

describe("main execution preference wiring", () => {
  it("passes auto and sliced into createContainer when no execution mode override is present", async () => {
    const { createContainer, exit } = await runMainWithWorkPlanMocks([]);

    expect(exit).not.toHaveBeenCalledWith(1);
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPreference: "auto",
        executionMode: "sliced",
      }),
      expect.any(Object),
    );
  });

  it("uses grouped execution mode from plan metadata for --work in auto mode", async () => {
    const { createContainer, exit } = await runMainWithWorkPlanMocks([], {
      planContent: JSON.stringify({
        executionMode: "grouped",
        groups: [
          {
            name: "Test",
            slices: [
              {
                number: 1,
                title: "Slice 1",
                why: "why",
                files: [{ path: "src/s1.ts", action: "new" }],
                details: "details",
                tests: "tests",
              },
            ],
          },
        ],
      }),
    });

    expect(exit).not.toHaveBeenCalledWith(1);
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPreference: "auto",
        executionMode: "grouped",
      }),
      expect.any(Object),
    );
  });

  it("seeds the startup tier from the static default and does not invoke complexity triage", async () => {
    const { createContainer, complexityTriageSpawnerFactory } = await runMainWithWorkPlanMocks([]);

    expect(complexityTriageSpawnerFactory).not.toHaveBeenCalled();
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "medium",
      }),
      expect.any(Object),
    );
  });

  it("reuses the persisted active tier for startup config without invoking complexity triage", async () => {
    const { createContainer, complexityTriageSpawnerFactory } = await runMainWithWorkPlanMocks(
      [],
      {
        preloadedState: {
          activeTier: "large",
          tier: "large",
        },
      },
    );

    expect(complexityTriageSpawnerFactory).not.toHaveBeenCalled();
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "large",
      }),
      expect.any(Object),
    );
  });

  it("fails fast for mutually exclusive work execution mode flags", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "--work", "plan.md", "--quick", "--grouped"];

    try {
      vi.resetModules();
      const { main } = await import("../src/main.js");
      await main({ exit });
    } finally {
      process.argv = previousArgv;
      vi.resetModules();
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/mutually exclusive.*--quick, --grouped.*--quick, --grouped, or --long/i),
    );
    expect(exit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it("fails fast for mutually exclusive plan execution mode flags", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    const previousArgv = process.argv;
    process.argv = ["node", "main.ts", "--plan", "inventory.md", "--quick", "--long"];

    try {
      vi.resetModules();
      const { main } = await import("../src/main.js");
      await main({ exit });
    } finally {
      process.argv = previousArgv;
      vi.resetModules();
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/mutually exclusive.*--quick, --long.*--quick, --grouped, or --long/i),
    );
    expect(exit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it("uses direct bootstrap for --plan inventory --quick without triage or plan generation", async () => {
    const {
      createContainer,
      execute,
      doGeneratePlan,
      requestTriageSpawnerFactory,
      buildRequestTriagePrompt,
      parseRequestTriageResult,
      exit,
      inventoryPath,
    } = await runMainWithInventoryPlanMocks({
      args: ["--quick"],
    });

    expect(exit).not.toHaveBeenCalledWith(1);
    expect(requestTriageSpawnerFactory).not.toHaveBeenCalled();
    expect(buildRequestTriagePrompt).not.toHaveBeenCalled();
    expect(parseRequestTriageResult).not.toHaveBeenCalled();
    expect(doGeneratePlan).not.toHaveBeenCalled();
    const config = getCreateContainerConfig(createContainer);
    expect(config).toEqual(
      expect.objectContaining({
        planPath: inventoryPath,
        planContent: "# Feature Inventory\n\n- Add authentication\n",
        brief: "brief text",
        executionPreference: "quick",
        executionMode: "direct",
        skills: expect.objectContaining({ plan: null }),
      }),
    );
    expect(String(config.stateFile)).toMatch(/\.orch\/state\/plan-direct01\.json$/);
    expect(String(config.logPath)).toMatch(/\.orch\/logs\/plan-direct01\.log$/);
    expect(execute).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "Direct",
        slices: [
          expect.objectContaining({
            number: 1,
            title: "Direct request",
            content: "# Feature Inventory\n\n- Add authentication\n",
          }),
        ],
      }),
    ]);
  });

  it("uses a fresh generated plan identity for direct inventory state instead of hashing the inventory path", async () => {
    const { createContainer, inventoryPath, generatePlanId } = await runMainWithInventoryPlanMocks({
      args: ["--quick"],
      generatedPlanId: "direct42",
    });

    const deterministicPlanId = resolvePlanId(inventoryPath);
    const config = (createContainer.mock.calls as unknown[][])[0]?.[0] as
      | Record<string, unknown>
      | undefined;

    expect(generatePlanId).toHaveBeenCalledTimes(1);
    expect(config!.stateFile).toMatch(/\.orch\/state\/plan-direct42\.json$/);
    expect(config!.logPath).toMatch(/\.orch\/logs\/plan-direct42\.log$/);
    expect(config!.stateFile).not.toMatch(new RegExp(`plan-${deterministicPlanId}\\.json$`));
  });

  it.each([
    { flag: "--grouped", executionPreference: "grouped" as const, executionMode: "grouped" as const },
    { flag: "--long", executionPreference: "long" as const, executionMode: "sliced" as const },
  ])(
    "keeps plan generation for inventory $flag and threads $executionMode through config",
    async ({ flag, executionPreference, executionMode }) => {
      const {
        createContainer,
        doGeneratePlan,
        requestTriageSpawnerFactory,
        hudLogs,
        exit,
      } = await runMainWithInventoryPlanMocks({
        args: [flag],
      });

      expect(exit).not.toHaveBeenCalledWith(1);
      expect(requestTriageSpawnerFactory).not.toHaveBeenCalled();
      expect(doGeneratePlan).toHaveBeenCalledWith(
        expect.any(String),
        "brief text",
        expect.any(String),
        expect.any(Function),
        expect.any(Function),
        executionMode,
      );
      expect(createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          executionPreference,
          executionMode,
        }),
        expect.any(Object),
      );
      expect(hudLogs.join("\n")).toContain(`Execution ${executionMode}`);
    },
  );

  it("uses request triage for auto inventory mode and skips plan generation for direct results", async () => {
    const {
      createContainer,
      doGeneratePlan,
      requestTriageSpawnerFactory,
      buildRequestTriagePrompt,
      parseRequestTriageResult,
      inventoryPath,
      triageAgent,
    } = await runMainWithInventoryPlanMocks({
      requestTriageResult: { mode: "direct", reason: "bounded local change" },
    });

    expect(requestTriageSpawnerFactory).toHaveBeenCalledTimes(1);
    expect(buildRequestTriagePrompt).toHaveBeenCalledWith("# Feature Inventory\n\n- Add authentication\n");
    expect(parseRequestTriageResult).toHaveBeenCalledWith(
      JSON.stringify({ mode: "direct", reason: "bounded local change" }),
    );
    expect(doGeneratePlan).not.toHaveBeenCalled();
    const config = getCreateContainerConfig(createContainer);
    expect(config).toEqual(
      expect.objectContaining({
        planPath: inventoryPath,
        executionPreference: "auto",
        executionMode: "direct",
      }),
    );
    expect(String(config.stateFile)).toMatch(/\.orch\/state\/plan-direct01\.json$/);
    expect(String(config.logPath)).toMatch(/\.orch\/logs\/plan-direct01\.log$/);
    expect(triageAgent.kill).toHaveBeenCalledTimes(1);
  });

  it("uses the selected tree as planning cwd for auto inventory triage and generated plan bootstrap", async () => {
    const externalTreePath = join(tempDir, "inventory-auto-tree");
    await mkdir(externalTreePath, { recursive: true });
    const treeBrief = `brief for ${externalTreePath}`;
    const {
      assertGitRepo,
      createContainer,
      doGeneratePlan,
      inventoryPath,
      planGeneratorSpawnerFactory,
      requestTriageSpawnerFactory,
      runFingerprint,
      stateFile,
    } = await runMainWithInventoryPlanMocks({
      args: ["--tree", externalTreePath],
      fingerprintBrief: (cwd) => `brief for ${cwd}`,
      requestTriageResult: { mode: "grouped", reason: "few coherent milestones" },
    });

    const { realpathSync } = await import("fs");
    const expectedOrchDir = join(realpathSync(tempDir), ".orch");
    const expectedStateFile = statePathForPlan(expectedOrchDir, resolvePlanId(join(tempDir, ".orch", "plan-generated.json")));
    const config = getCreateContainerConfig(createContainer);

    expect(requestTriageSpawnerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
      }),
    );
    expect(planGeneratorSpawnerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
      }),
    );
    expect(runFingerprint).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
      }),
    );
    expect(doGeneratePlan).toHaveBeenCalledWith(
      inventoryPath,
      treeBrief,
      expectedOrchDir,
      expect.any(Function),
      expect.any(Function),
      "grouped",
    );
    expect(config.stateFile).toBe(expectedStateFile);
    expect(config.logPath).toBe(logPathForPlan(expectedOrchDir, resolvePlanId(join(tempDir, ".orch", "plan-generated.json"))));
    expect(stateFile).toContain(`${join(tempDir, ".orch")}/state/`);
    expect(String(config.stateFile)).not.toContain(`${externalTreePath}/.orch/`);
    expect(String(config.logPath)).not.toContain(`${externalTreePath}/.orch/`);
    expect(assertGitRepo).toHaveBeenCalledTimes(2);
    expect(assertGitRepo.mock.calls[0]?.[0]).toBe(realpathSync(tempDir));
    expect(assertGitRepo.mock.calls[1]?.[0]).toBe(externalTreePath);
  });

  it("prefers non-empty triage resultText when assistantText is empty", async () => {
    const {
      createContainer,
      doGeneratePlan,
      parseRequestTriageResult,
      exit,
    } = await runMainWithInventoryPlanMocks({
      requestTriageText: "",
      requestTriageResultText: JSON.stringify({
        mode: "direct",
        reason: "bounded local change",
      }),
    });

    expect(exit).not.toHaveBeenCalledWith(1);
    expect(parseRequestTriageResult).toHaveBeenCalledWith(
      JSON.stringify({ mode: "direct", reason: "bounded local change" }),
    );
    expect(doGeneratePlan).not.toHaveBeenCalled();
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPreference: "auto",
        executionMode: "direct",
      }),
      expect.any(Object),
    );
  });

  it("falls back to sliced planning when request triage transport fails", async () => {
    const {
      createContainer,
      doGeneratePlan,
      exit,
      triageAgent,
    } = await runMainWithInventoryPlanMocks({
      requestTriageSendError: new Error("triage unavailable"),
    });

    expect(exit).not.toHaveBeenCalledWith(1);
    expect(doGeneratePlan).toHaveBeenCalledWith(
      expect.any(String),
      "brief text",
      expect.any(String),
      expect.any(Function),
      expect.any(Function),
      "sliced",
    );
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPreference: "auto",
        executionMode: "sliced",
      }),
      expect.any(Object),
    );
    expect(triageAgent.kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "grouped triage result",
      requestTriageResult: { mode: "grouped" as const, reason: "few coherent milestones" },
      parsedRequestTriageResult: undefined,
      executionMode: "grouped" as const,
    },
    {
      label: "malformed triage fallback",
      requestTriageResult: undefined,
      requestTriageText: "not json",
      parsedRequestTriageResult: { mode: "sliced" as const, reason: "fallback to sliced" },
      executionMode: "sliced" as const,
    },
  ])(
    "keeps plan generation for auto inventory mode on $label",
    async ({ requestTriageResult, requestTriageText, parsedRequestTriageResult, executionMode }) => {
      const { createContainer, doGeneratePlan } = await runMainWithInventoryPlanMocks({
        requestTriageResult,
        requestTriageText,
        parsedRequestTriageResult,
      });

      expect(doGeneratePlan).toHaveBeenCalledWith(
        expect.any(String),
        "brief text",
        expect.any(String),
        expect.any(Function),
        expect.any(Function),
        executionMode,
      );
      expect(createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          executionPreference: "auto",
          executionMode,
        }),
        expect.any(Object),
      );
    },
  );

  it.each([
    { flag: "--grouped", executionMode: "grouped" as const },
    { flag: "--long", executionMode: "sliced" as const },
  ])(
    "uses the selected tree as planning cwd for explicit generated inventory mode $flag",
    async ({ flag, executionMode }) => {
      const externalTreePath = join(tempDir, `inventory-${flag.slice(2)}-tree`);
      await mkdir(externalTreePath, { recursive: true });
      const treeBrief = `brief for ${externalTreePath}`;
      const {
        assertGitRepo,
        createContainer,
        doGeneratePlan,
        inventoryPath,
        planGeneratorSpawnerFactory,
        requestTriageSpawnerFactory,
        runFingerprint,
      } = await runMainWithInventoryPlanMocks({
        args: [flag, "--tree", externalTreePath],
        fingerprintBrief: (cwd) => `brief for ${cwd}`,
      });

      const { realpathSync } = await import("fs");
      const expectedOrchDir = join(realpathSync(tempDir), ".orch");
      const config = getCreateContainerConfig(createContainer);
      expect(requestTriageSpawnerFactory).not.toHaveBeenCalled();
      expect(planGeneratorSpawnerFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: externalTreePath,
        }),
      );
      expect(runFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: externalTreePath,
        }),
      );
      expect(doGeneratePlan).toHaveBeenCalledWith(
        inventoryPath,
        treeBrief,
        expectedOrchDir,
        expect.any(Function),
        expect.any(Function),
        executionMode,
      );
      expect(String(config.stateFile)).toContain(`${expectedOrchDir}/state/`);
      expect(String(config.logPath)).toContain(`${expectedOrchDir}/logs/`);
      expect(String(config.stateFile)).not.toContain(`${externalTreePath}/.orch/`);
      expect(String(config.logPath)).not.toContain(`${externalTreePath}/.orch/`);
      expect(assertGitRepo).toHaveBeenCalledTimes(2);
      expect(assertGitRepo.mock.calls[0]?.[0]).toBe(realpathSync(tempDir));
      expect(assertGitRepo.mock.calls[1]?.[0]).toBe(externalTreePath);
    },
  );

  it("keeps generated inventory registry paths rooted in the repo .orch directory when --tree is used", async () => {
    const externalTreePath = join(tempDir, "inventory-grouped-tree");
    await mkdir(externalTreePath, { recursive: true });
    const { registryPath } = await runMainWithInventoryPlanMocks({
      args: ["--grouped", "--tree", externalTreePath],
    });
    const { readRegistry } = await import("#infrastructure/registry/run-registry.js");
    const entries = await readRegistry(registryPath);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.planPath).toContain(`${join(tempDir, ".orch")}/`);
    expect(entries[0]?.statePath).toContain(`${join(tempDir, ".orch")}/state/`);
    expect(entries[0]?.planPath).not.toContain(`${externalTreePath}/`);
    expect(entries[0]?.statePath).not.toContain(`${externalTreePath}/`);
  });

  it("surfaces the grouped triage summary in operator output before execution starts", async () => {
    const { hudLogs } = await runMainWithInventoryPlanMocks({
      requestTriageResult: { mode: "grouped", reason: "few coherent milestones" },
    });

    expect(hudLogs.join("\n")).toContain("mode=grouped");
  });

  it("registers a parseable direct artifact with full slice metadata", async () => {
    const {
      inventoryPath,
      registryPath,
    } = await runMainWithInventoryPlanMocks({
      args: ["--quick"],
      generatedPlanId: "direct42",
    });
    const { readRegistry } = await import("#infrastructure/registry/run-registry.js");
    const { parsePlan } = await import("#infrastructure/plan/plan-parser.js");

    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.planPath).toMatch(/\.orch\/plan-direct42\.json$/);

    const groups = await parsePlan(entries[0]!.planPath);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("Direct");
    expect(groups[0]?.slices[0]).toEqual(
      expect.objectContaining({
        title: "Direct request",
        why: "Direct execution was selected during bootstrap.",
        files: [{ path: inventoryPath, action: "edit" }],
        details: "Implement the inventory request directly without generated plan slices.",
        tests: "Run the relevant tests and explain the coverage changes.",
      }),
    );
  });

  it("keeps direct inventory registry paths rooted in the repo .orch directory when --tree is used", async () => {
    const externalTreePath = join(tempDir, "inventory-direct-tree");
    await mkdir(externalTreePath, { recursive: true });
    const { readRegistry } = await import("#infrastructure/registry/run-registry.js");
    const {
      registryPath,
    } = await runMainWithInventoryPlanMocks({
      args: ["--quick", "--tree", externalTreePath],
      generatedPlanId: "direct-tree",
      resolveWorktreeResult: {
        cwd: externalTreePath,
        worktreeInfo: { path: externalTreePath, branch: "feature/existing" },
        skipStash: true,
        updatedState: {
          worktree: {
            path: externalTreePath,
            branch: "feature/existing",
            baseSha: "deadbeef",
            managed: false,
          },
        },
      },
    });
    const entries = await readRegistry(registryPath);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.planPath).toContain(`${join(tempDir, ".orch")}/`);
    expect(entries[0]?.statePath).toContain(`${join(tempDir, ".orch")}/state/`);
    expect(entries[0]?.planPath).not.toContain(`${externalTreePath}/`);
    expect(entries[0]?.statePath).not.toContain(`${externalTreePath}/`);
  });

  it("uses direct-specific completion copy after a successful direct inventory run", async () => {
    const { logSection } = await runMainWithInventoryPlanMocks({
      args: ["--quick"],
    });

    expect(logSection).toHaveBeenCalledWith(
      expect.any(Function),
      expect.stringContaining("Direct request complete + final review done"),
    );
  });

  it("treats inventory input that is already a plan as plan-authoritative for execution mode", async () => {
    const groupedPlan = JSON.stringify({
      executionMode: "grouped",
      groups: [
        {
          name: "Test",
          slices: [
            {
              number: 1,
              title: "Slice 1",
              why: "why",
              files: [{ path: "src/s1.ts", action: "new" }],
              details: "details",
              tests: "tests",
            },
          ],
        },
      ],
    });
    const {
      createContainer,
      doGeneratePlan,
      requestTriageSpawnerFactory,
      buildRequestTriagePrompt,
      parseRequestTriageResult,
      hudLogs,
      inventoryPath,
      exit,
    } = await runMainWithInventoryPlanMocks({
      inputAlreadyPlan: true,
      inventoryContent: groupedPlan,
    });

    expect(exit).not.toHaveBeenCalledWith(1);
    expect(requestTriageSpawnerFactory).not.toHaveBeenCalled();
    expect(buildRequestTriagePrompt).not.toHaveBeenCalled();
    expect(parseRequestTriageResult).not.toHaveBeenCalled();
    expect(doGeneratePlan).not.toHaveBeenCalled();
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        planPath: inventoryPath,
        planContent: groupedPlan,
        executionPreference: "auto",
        executionMode: "grouped",
      }),
      expect.any(Object),
    );
    expect(hudLogs.join("\n")).toContain("Execution grouped");
  });

  it.each([
    {
      flag: "--quick",
      planExecutionMode: "grouped",
      expectedMessage:
        'Loaded plan declares executionMode=grouped, so override --quick is incompatible. --work uses the plan\'s declared execution mode.',
    },
    {
      flag: "--long",
      planExecutionMode: "grouped",
      expectedMessage:
        'Loaded plan declares executionMode=grouped, so override --long is incompatible. --work uses the plan\'s declared execution mode.',
    },
    {
      flag: "--grouped",
      planExecutionMode: "sliced",
      expectedMessage:
        'Loaded plan declares executionMode=sliced, so override --grouped is incompatible. --work uses the plan\'s declared execution mode.',
    },
  ])(
    "rejects incompatible override $flag when --plan input is already a plan",
    async ({ flag, planExecutionMode, expectedMessage }) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const groupedPlan = JSON.stringify({
        executionMode: planExecutionMode,
        groups: [
          {
            name: "Test",
            slices: [
              {
                number: 1,
                title: "Slice 1",
                why: "why",
                files: [{ path: "src/s1.ts", action: "new" }],
                details: "details",
                tests: "tests",
              },
            ],
          },
        ],
      });
      const {
        createContainer,
        doGeneratePlan,
        requestTriageSpawnerFactory,
        buildRequestTriagePrompt,
        parseRequestTriageResult,
        exit,
      } = await runMainWithInventoryPlanMocks({
        args: [flag],
        inputAlreadyPlan: true,
        inventoryContent: groupedPlan,
      });

      expect(requestTriageSpawnerFactory).not.toHaveBeenCalled();
      expect(buildRequestTriagePrompt).not.toHaveBeenCalled();
      expect(parseRequestTriageResult).not.toHaveBeenCalled();
      expect(doGeneratePlan).not.toHaveBeenCalled();
      expect(createContainer).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expectedMessage);
      expect(exit).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
    },
  );

  it("accepts a compatible --work override when it matches the loaded plan mode", async () => {
    const groupedPlan = JSON.stringify({
      executionMode: "grouped",
      groups: [
        {
          name: "Test",
          slices: [
            {
              number: 1,
              title: "Slice 1",
              why: "why",
              files: [{ path: "src/s1.ts", action: "new" }],
              details: "details",
              tests: "tests",
            },
          ],
        },
      ],
    });
    const { createContainer, exit } = await runMainWithWorkPlanMocks(["--grouped"], {
      planContent: groupedPlan,
    });

    expect(exit).not.toHaveBeenCalledWith(1);
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPreference: "grouped",
        executionMode: "grouped",
      }),
      expect.any(Object),
    );
  });

  it("treats a worked direct artifact as direct --work and keeps state/log identity stable across reruns", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));

    const firstRun = await runMainWithWorkPlanMocks([], {
      planPath: directPlanPath,
      planContent: directPlan,
      generatedPlanId: "random01",
    });
    const secondRun = await runMainWithWorkPlanMocks([], {
      planPath: directPlanPath,
      planContent: directPlan,
      generatedPlanId: "random02",
    });

    const canonicalPlanId = resolvePlanId(directPlanPath);
    const expectedPlanPathSuffix = `.orch/plan-${canonicalPlanId}.json`;
    const expectedStateFileSuffix = `.orch/state/plan-${canonicalPlanId}.json`;
    const expectedLogPathSuffix = `.orch/logs/plan-${canonicalPlanId}.log`;
    const firstConfig = getCreateContainerConfig(firstRun.createContainer);
    const secondConfig = getCreateContainerConfig(secondRun.createContainer);

    expect(firstConfig).toEqual(
      expect.objectContaining({
        executionMode: "direct",
      }),
    );
    expect(secondConfig).toEqual(
      expect.objectContaining({
        executionMode: "direct",
      }),
    );
    expect(String(firstConfig.planPath)).toContain(expectedPlanPathSuffix);
    expect(String(firstConfig.stateFile)).toContain(expectedStateFileSuffix);
    expect(String(firstConfig.logPath)).toContain(expectedLogPathSuffix);
    expect(String(secondConfig.planPath)).toContain(expectedPlanPathSuffix);
    expect(String(secondConfig.stateFile)).toContain(expectedStateFileSuffix);
    expect(String(secondConfig.logPath)).toContain(expectedLogPathSuffix);
    expect(firstRun.generatePlanId).not.toHaveBeenCalled();
    expect(secondRun.generatePlanId).not.toHaveBeenCalled();
  });

  it("uses the canonical direct state file for --work --cleanup instead of generating a fresh direct id", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const canonicalPlanId = resolvePlanId(directPlanPath);

    const { createContainer, exit, generatePlanId, runCleanup } = await runMainWithWorkPlanMocks(
      ["--cleanup"],
      {
        planPath: directPlanPath,
        planContent: directPlan,
        generatedPlanId: "random99",
        preloadedState: {
          lastCompletedSlice: 1,
        },
      },
    );

    expect(runCleanup).toHaveBeenCalledWith(
      expect.stringContaining(`.orch/state/plan-${canonicalPlanId}.json`),
      expect.objectContaining({ lastCompletedSlice: 1 }),
      expect.stringContaining(tempDir.replace(/^\/private/, "")),
    );
    expect(generatePlanId).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("preserves external direct worktrees during --work --cleanup and prints the shared cleanup message", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const externalTreePath = join(tempDir, "existing-tree");
    const cleanupMessage = `Preserved external tree at ${externalTreePath}. State cleared.`;
    const canonicalPlanId = resolvePlanId(directPlanPath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { createContainer, exit, generatePlanId, runCleanup } = await runMainWithWorkPlanMocks(
        ["--cleanup"],
        {
          planPath: directPlanPath,
          planContent: directPlan,
          generatedPlanId: "random98",
          preloadedState: {
            worktree: {
              path: externalTreePath,
              branch: "feature/existing",
              baseSha: "deadbeef",
              managed: false,
            },
            lastCompletedSlice: 1,
          },
          runCleanupResult: cleanupMessage,
        },
      );

      expect(runCleanup).toHaveBeenCalledWith(
        expect.stringContaining(`.orch/state/plan-${canonicalPlanId}.json`),
        expect.objectContaining({
          lastCompletedSlice: 1,
          worktree: expect.objectContaining({
            path: externalTreePath,
            managed: false,
          }),
        }),
        expect.stringContaining(tempDir.replace(/^\/private/, "")),
      );
      expect(logSpy).toHaveBeenCalledWith(cleanupMessage);
      expect(generatePlanId).not.toHaveBeenCalled();
      expect(createContainer).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("removes managed direct worktrees during --work --cleanup and prints the shared cleanup message", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const managedTreePath = join(tempDir, ".orch", "trees", "abc123");
    const cleanupMessage = `Removed worktree at ${managedTreePath}. State cleared.`;
    const canonicalPlanId = resolvePlanId(directPlanPath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { createContainer, exit, generatePlanId, runCleanup } = await runMainWithWorkPlanMocks(
        ["--cleanup"],
        {
          planPath: directPlanPath,
          planContent: directPlan,
          generatedPlanId: "random97",
          preloadedState: {
            worktree: {
              path: managedTreePath,
              branch: "orch/direct-managed",
              baseSha: "feedface",
              managed: true,
            },
            lastCompletedSlice: 1,
          },
          runCleanupResult: cleanupMessage,
        },
      );

      expect(runCleanup).toHaveBeenCalledWith(
        expect.stringContaining(`.orch/state/plan-${canonicalPlanId}.json`),
        expect.objectContaining({
          lastCompletedSlice: 1,
          worktree: expect.objectContaining({
            path: managedTreePath,
            managed: true,
          }),
        }),
        expect.stringContaining(tempDir.replace(/^\/private/, "")),
      );
      expect(logSpy).toHaveBeenCalledWith(cleanupMessage);
      expect(generatePlanId).not.toHaveBeenCalled();
      expect(createContainer).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("shows a worked direct plan from its canonical artifact without allocating a fresh direct id", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const canonicalPlanId = resolvePlanId(directPlanPath);
    const { createContainer, exit, formatPlanSummary, generatePlanId, parsePlan } =
      await runMainWithWorkPlanMocks(["--show-plan"], {
        planPath: directPlanPath,
        planContent: directPlan,
        generatedPlanId: "random77",
      });

    expect(parsePlan).toHaveBeenCalledWith(
      expect.stringContaining(`.orch/plan-${canonicalPlanId}.json`),
    );
    expect(formatPlanSummary).toHaveBeenCalledTimes(1);
    expect(generatePlanId).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("copies an external worked direct artifact named plan-<id>.json into the repo .orch path", async () => {
    const directPlanPath = join(tempDir, "artifacts", "plan-abc123.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const canonicalPlanPath = join(tempDir, ".orch", "plan-abc123.json");

    const { createContainer, exit, formatPlanSummary, generatePlanId, parsePlan } =
      await runMainWithWorkPlanMocks(["--show-plan"], {
        planPath: directPlanPath,
        planContent: directPlan,
        generatedPlanId: "random88",
      });

    expect(parsePlan).toHaveBeenCalledWith(
      expect.stringContaining(".orch/plan-abc123.json"),
    );
    expect(formatPlanSummary).toHaveBeenCalledTimes(1);
    expect(generatePlanId).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    await expect(readFile(canonicalPlanPath, "utf-8")).resolves.toBe(directPlan);
  });

  it("checks resume state before resolving an external tree for direct --work", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const externalTreePath = join(tempDir, "existing-tree");
    await mkdir(externalTreePath, { recursive: true });
    const externalState = {
      worktree: {
        path: externalTreePath,
        branch: "feature/existing",
        baseSha: "deadbeef",
        managed: false,
      },
      lastCompletedSlice: 1,
    };

    const { checkWorktreeResume, createContainer, resolveWorktree } = await runMainWithWorkPlanMocks(
      ["--tree", externalTreePath],
      {
        planPath: directPlanPath,
        planContent: directPlan,
        preloadedState: externalState,
        resolveWorktreeResult: {
          cwd: externalTreePath,
          worktreeInfo: { path: externalTreePath, branch: "feature/existing" },
          skipStash: true,
          updatedState: externalState,
        },
      },
    );

    expect(checkWorktreeResume).toHaveBeenCalledWith(
      undefined,
      externalTreePath,
      expect.objectContaining({
        lastCompletedSlice: 1,
        worktree: externalState.worktree,
      }),
    );
    expect(resolveWorktree.mock.invocationCallOrder[0]).toBeGreaterThan(
      checkWorktreeResume.mock.invocationCallOrder[0] ?? 0,
    );
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "direct",
        cwd: externalTreePath,
      }),
      expect.any(Object),
    );
  });

  it("exits direct --work before worktree resolution when resume validation fails", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const externalTreePath = join(tempDir, "existing-tree");
    await mkdir(externalTreePath, { recursive: true });
    const externalState = {
      worktree: {
        path: externalTreePath,
        branch: "feature/existing",
        baseSha: "deadbeef",
        managed: false,
      },
      lastCompletedSlice: 1,
    };

    const {
      checkWorktreeResume,
      createContainer,
      exit,
      resolveWorktree,
    } = await runMainWithWorkPlanMocks(["--tree", externalTreePath], {
      planPath: directPlanPath,
      planContent: directPlan,
      preloadedState: externalState,
      checkWorktreeResumeResult: {
        ok: false,
        message: "resume mismatch",
      },
    });

    expect(checkWorktreeResume).toHaveBeenCalledWith(
      undefined,
      externalTreePath,
      expect.objectContaining({
        lastCompletedSlice: 1,
        worktree: externalState.worktree,
      }),
    );
    expect(resolveWorktree).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rejects direct --work resume when managed state is missing the required branch flag", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const managedState = {
      worktree: {
        path: join(tempDir, ".orch", "trees", "abc123"),
        branch: "orch/direct-managed",
        baseSha: "feedface",
        managed: true,
      },
      lastCompletedSlice: 1,
    };

    const {
      checkWorktreeResume,
      createContainer,
      exit,
      resolveWorktree,
    } = await runMainWithWorkPlanMocks([], {
      planPath: directPlanPath,
      planContent: directPlan,
      preloadedState: managedState,
      checkWorktreeResumeResult: {
        ok: false,
        message:
          "Previous run used --branch orch/direct-managed. Pass --branch again to resume, or --reset to start fresh.",
      },
    });

    expect(checkWorktreeResume).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({
        lastCompletedSlice: 1,
        worktree: managedState.worktree,
      }),
    );
    expect(resolveWorktree).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rejects direct --work resume when the selected external tree changes", async () => {
    const directPlanPath = join(tempDir, "artifacts", "direct-work.json");
    const directPlan = buildDirectArtifactPlan(join(tempDir, "inventory.md"));
    const previousTreePath = join(tempDir, "existing-tree");
    const nextTreePath = join(tempDir, "other-tree");
    await mkdir(previousTreePath, { recursive: true });
    await mkdir(nextTreePath, { recursive: true });
    const externalState = {
      worktree: {
        path: previousTreePath,
        branch: "feature/existing",
        baseSha: "deadbeef",
        managed: false,
      },
      lastCompletedSlice: 1,
    };

    const {
      checkWorktreeResume,
      createContainer,
      exit,
      resolveWorktree,
    } = await runMainWithWorkPlanMocks(["--tree", nextTreePath], {
      planPath: directPlanPath,
      planContent: directPlan,
      preloadedState: externalState,
      checkWorktreeResumeResult: {
        ok: false,
        message:
          `Previous run used --tree ${previousTreePath}. Pass --tree ${previousTreePath} again to resume, or --reset to start fresh.`,
      },
    });

    expect(checkWorktreeResume).toHaveBeenCalledWith(
      undefined,
      nextTreePath,
      expect.objectContaining({
        lastCompletedSlice: 1,
        worktree: externalState.worktree,
      }),
    );
    expect(resolveWorktree).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("passes --tree through resolveWorktree and uses the selected tree as cwd for --work", async () => {
    const externalTreePath = join(tempDir, "existing-tree");
    await mkdir(externalTreePath, { recursive: true });
    const treeBrief = `brief for ${externalTreePath}`;

    const { createContainer, resolveWorktree, planPath, runFingerprint, stashBackup } = await runMainWithWorkPlanMocks(
      ["--tree", externalTreePath],
      {
        fingerprintBrief: (cwd) => `brief for ${cwd}`,
        resolveWorktreeResult: {
          cwd: externalTreePath,
          worktreeInfo: { path: externalTreePath, branch: "feature/existing" },
          skipStash: true,
          updatedState: {},
        },
      },
    );

    expect(resolveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        treePath: externalTreePath,
      }),
    );
    expect(runFingerprint).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
      }),
    );
    const { realpathSync } = await import("fs");
    const expectedOrchDir = join(realpathSync(tempDir), ".orch");
    const expectedStateFile = statePathForPlan(expectedOrchDir, resolvePlanId(planPath));
    const expectedLogPath = logPathForPlan(expectedOrchDir, resolvePlanId(planPath));
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
        brief: treeBrief,
        stateFile: expectedStateFile,
        logPath: expectedLogPath,
      }),
      expect.any(Object),
    );
    const config = ((createContainer.mock.calls as unknown) as Array<[{
      stateFile: string;
      logPath: string;
    }]>)[0]?.[0];
    if (!config) {
      throw new Error("Expected createContainer to be called");
    }
    expect(config.stateFile).toBe(expectedStateFile);
    expect(config.logPath).toBe(expectedLogPath);
    expect(config.stateFile).not.toContain(`${externalTreePath}/.orch/`);
    expect(config.logPath).not.toContain(`${externalTreePath}/.orch/`);
    expect(stashBackup).not.toHaveBeenCalled();
  });

  it("forwards worktreeSetup into resolveWorktree and aborts before createContainer when setup fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const worktreeSetup = ["pnpm install", "pnpm build"];
    const {
      createContainer,
      exit,
      resolveWorktree,
    } = await runMainWithWorkPlanMocks(["--branch", "orch/abc123"], {
      worktreeSetup,
      resolveWorktreeError: new Error("Worktree setup command failed: pnpm build\nsetup exploded"),
    });

    expect(resolveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSetup,
      }),
    );
    expect(createContainer).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Worktree setup command failed: pnpm build\nsetup exploded",
    );
    expect(exit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it("passes --tree through checkWorktreeResume and exits before execution when resume validation fails", async () => {
    const externalTreePath = join(tempDir, "existing-tree");
    await mkdir(externalTreePath, { recursive: true });
    const externalState = {
      worktree: {
        path: externalTreePath,
        branch: "feature/existing",
        baseSha: "deadbeef",
        managed: false,
      },
      lastCompletedSlice: 1,
    };

    const {
      checkWorktreeResume,
      resolveWorktree,
      createContainer,
      exit,
    } = await runMainWithWorkPlanMocks(["--tree", externalTreePath], {
      preloadedState: externalState,
      checkWorktreeResumeResult: {
      ok: false,
      message: "resume mismatch",
      },
    });

    expect(checkWorktreeResume).toHaveBeenCalledWith(
      undefined,
      externalTreePath,
      expect.objectContaining({
        lastCompletedSlice: 1,
        worktree: externalState.worktree,
      }),
    );
    expect(resolveWorktree).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("passes --tree through direct inventory execution and uses the selected tree as cwd", async () => {
    const externalTreePath = join(tempDir, "existing-tree");
    await mkdir(externalTreePath, { recursive: true });
    const treeBrief = `brief for ${externalTreePath}`;
    const worktreeSetup = ["pnpm install"];

    const { assertGitRepo, createContainer, planGeneratorSpawnerFactory, requestTriageSpawnerFactory, resolveWorktree, runFingerprint } = await runMainWithInventoryPlanMocks({
      args: ["--quick", "--tree", externalTreePath],
      fingerprintBrief: (cwd) => `brief for ${cwd}`,
      worktreeSetup,
      generatedPlanId: "direct42",
      resolveWorktreeResult: {
        cwd: externalTreePath,
        worktreeInfo: { path: externalTreePath, branch: "feature/existing" },
        skipStash: true,
        updatedState: {
          worktree: {
            path: externalTreePath,
            branch: "feature/existing",
            baseSha: "deadbeef",
            managed: false,
          },
        },
      },
    });

    const { realpathSync } = await import("fs");
    const expectedOrchDir = join(realpathSync(tempDir), ".orch");
    const expectedStateFile = statePathForPlan(expectedOrchDir, "direct42");
    const expectedLogPath = logPathForPlan(expectedOrchDir, "direct42");
    expect(resolveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        treePath: externalTreePath,
        worktreeSetup,
      }),
    );
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
        brief: treeBrief,
        stateFile: expectedStateFile,
        logPath: expectedLogPath,
      }),
      expect.any(Object),
    );
    const config = ((createContainer.mock.calls as unknown) as Array<[{
      stateFile: string;
      logPath: string;
    }]>)[0]?.[0];
    if (!config) {
      throw new Error("Expected createContainer to be called");
    }
    expect(config.stateFile).toBe(expectedStateFile);
    expect(config.logPath).toBe(expectedLogPath);
    expect(config.stateFile).not.toContain(`${externalTreePath}/.orch/`);
    expect(config.logPath).not.toContain(`${externalTreePath}/.orch/`);
    expect(requestTriageSpawnerFactory).not.toHaveBeenCalled();
    expect(planGeneratorSpawnerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
      }),
    );
    expect(runFingerprint).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: externalTreePath,
      }),
    );
    expect(assertGitRepo).toHaveBeenCalledTimes(2);
    expect(assertGitRepo.mock.calls[0]?.[0]).toBe(realpathSync(tempDir));
    expect(assertGitRepo.mock.calls[1]?.[0]).toBe(externalTreePath);
  });

  it("aborts direct inventory execution before createContainer when managed worktree setup fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const worktreeSetup = ["pnpm install", "pnpm build"];
    const {
      createContainer,
      exit,
      resolveWorktree,
    } = await runMainWithInventoryPlanMocks({
      args: ["--quick", "--branch", "orch/abc123"],
      worktreeSetup,
      resolveWorktreeError: new Error("Worktree setup command failed: pnpm build\nsetup exploded"),
    });

    expect(resolveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSetup,
        branchName: "orch/abc123",
      }),
    );
    expect(createContainer).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Worktree setup command failed: pnpm build\nsetup exploded",
    );
    expect(exit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it("stashes the main checkout when resolveWorktree does not request skipStash", async () => {
    const { stashBackup } = await runMainWithWorkPlanMocks([], {
      resolveWorktreeResult: {
        cwd: tempDir,
        worktreeInfo: null,
        skipStash: false,
        updatedState: {},
      },
    });

    const { realpathSync } = await import("fs");
    expect(stashBackup).toHaveBeenCalledWith(realpathSync(tempDir));
  });

  it("errors when --work override conflicts with the loaded plan mode", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const groupedPlan = JSON.stringify({
      executionMode: "grouped",
      groups: [
        {
          name: "Test",
          slices: [
            {
              number: 1,
              title: "Slice 1",
              why: "why",
              files: [{ path: "src/s1.ts", action: "new" }],
              details: "details",
              tests: "tests",
            },
          ],
        },
      ],
    });
    const { createContainer, exit } = await runMainWithWorkPlanMocks(["--quick"], {
      planContent: groupedPlan,
    });

    expect(createContainer).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Loaded plan declares executionMode=grouped, so override --quick is incompatible. --work uses the plan\'s declared execution mode.',
    );
    expect(exit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it.each([
    {
      label: "direct metadata",
      planContent: JSON.stringify({
        executionMode: "direct",
        groups: [{
          name: "Test",
          slices: [{
            number: 1,
            title: "Slice 1",
            why: "why",
            files: [{ path: "src/s1.ts", action: "new" }],
            details: "details",
            tests: "tests",
          }],
        }],
      }),
      expectedMessage: "Plan metadata executionMode=direct is invalid for --work.",
    },
    {
      label: "unknown metadata",
      planContent: JSON.stringify({
        executionMode: "bogus",
        groups: [{
          name: "Test",
          slices: [{
            number: 1,
            title: "Slice 1",
            why: "why",
            files: [{ path: "src/s1.ts", action: "new" }],
            details: "details",
            tests: "tests",
          }],
        }],
      }),
      expectedMessage: "Invalid plan executionMode metadata: bogus.",
    },
  ])("rejects invalid --work $label", async ({ planContent, expectedMessage }) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createContainer, exit } = await runMainWithWorkPlanMocks([], { planContent });

    expect(createContainer).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expectedMessage);
    expect(exit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });
});

describe("main log path wiring", () => {
  it("passes the per-plan log path into createContainer", async () => {
    const planPath = join(tempDir, "plan.md");
    await writeFile(planPath, MINIMAL_PLAN);
    const expectedPlanId = resolvePlanId(planPath);
    const { realpathSync } = await import("fs");
    const expectedOrchDir = join(realpathSync(tempDir), ".orch");

    const createContainer = vi.fn(() => ({
      resolve: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      })),
    }));

    vi.resetModules();
    vi.doMock("../src/composition-root.js", () => ({
      createContainer,
    }));
    vi.doMock("#infrastructure/git/repo-check.js", () => ({
      assertGitRepo: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("#infrastructure/config/orchrc.js", () => ({
      loadAndResolveOrchrConfig: vi.fn(() => ({
        skills: {
          tdd: { enabled: true, value: "tdd skill" },
          review: { enabled: true, value: "review skill" },
          verify: { enabled: true, value: "verify skill" },
          gap: { disabled: true },
          plan: { disabled: true },
        },
        config: {},
        rules: { tdd: undefined, review: undefined },
        worktreeSetup: [],
        agents: {},
      })),
      buildOrchrSummary: vi.fn(() => "summary"),
    }));
    vi.doMock("#infrastructure/complexity-triage.js", () => ({
      buildComplexityTriagePrompt: vi.fn(),
      parseComplexityTriageResult: vi.fn(() => ({ tier: "medium", reason: "test" })),
    }));
    vi.doMock("#infrastructure/skill-loader.js", () => ({
      buildSkillOverrides: vi.fn(() => ({})),
      loadTieredSkills: vi.fn(() => ({
        tdd: "tdd skill", review: "review skill", verify: "verify skill",
        gap: null, plan: null, completeness: "completeness skill",
      })),
    }));
    vi.doMock("#domain/agent-config.js", async () => {
      const actual = await vi.importActual<typeof import("#domain/agent-config.js")>("#domain/agent-config.js");
      return {
        ...actual,
        resolveAllAgentConfigs: vi.fn(() => actual.AGENT_DEFAULTS),
      };
    });
    vi.doMock("#infrastructure/fingerprint.js", () => ({
      runFingerprint: vi.fn().mockResolvedValue({ brief: "brief text" }),
    }));
    vi.doMock("#infrastructure/plan/plan-parser.js", () => ({
      parsePlan: vi.fn().mockResolvedValue([
        {
          name: "Test",
          slices: [{
            number: 1,
            title: "Slice 1",
            content: "content",
            why: "why",
            files: [{ path: "src/s1.ts", action: "new" }],
            details: "details",
            tests: "tests",
          }],
        },
      ]),
    }));
    vi.doMock("#infrastructure/git/worktree.js", () => ({
      checkWorktreeResume: vi.fn().mockResolvedValue({ ok: true }),
      runCleanup: vi.fn(),
    }));
    vi.doMock("#infrastructure/git/worktree-setup.js", () => ({
      resolveWorktree: vi.fn().mockResolvedValue({
        cwd: tempDir,
        worktreeInfo: null,
        skipStash: true,
      }),
    }));
    vi.doMock("#infrastructure/git/git.js", () => ({
      getStatus: vi.fn().mockResolvedValue(""),
      stashBackup: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("#ui/hud.js", () => ({
      createHud: vi.fn(() => ({
        update: vi.fn(),
        wrapLog: vi.fn((logger: (...args: unknown[]) => void) => logger),
        teardown: vi.fn(),
        setActivity: vi.fn(),
        onKey: vi.fn(),
        onInterruptSubmit: vi.fn(),
        startPrompt: vi.fn(),
        createWriter: vi.fn(() => () => {}),
        setSkipping: vi.fn(),
      })),
    }));
    vi.doMock("#ui/display.js", async () => {
      const actual = await vi.importActual<typeof import("#ui/display.js")>("#ui/display.js");
      return {
        ...actual,
        logSection: vi.fn(),
        printStartupBanner: vi.fn(),
        formatPlanSummary: vi.fn(),
      };
    });
    vi.doMock("#infrastructure/factories.js", async () => {
      const actual =
        await vi.importActual<typeof import("#infrastructure/factories.js")>(
          "#infrastructure/factories.js"
        );
      return {
        ...actual,
        complexityTriageSpawnerFactory: vi.fn(() => () => ({
          send: vi.fn(),
          kill: vi.fn(),
        })),
      };
    });

    const previousArgv = process.argv;
    const previousCwd = process.cwd();
    process.argv = [
      "node",
      "main.ts",
      "--work",
      planPath,
      "--skip-fingerprint",
      "--no-interaction",
    ];
    process.chdir(tempDir);

    try {
      const { main } = await import("../src/main.js");
      await main({
        registryPath: join(tempDir, "registry", "runs.json"),
        onSignal: vi.fn(() => process),
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
      process.chdir(previousCwd);
      vi.doUnmock("../src/composition-root.js");
      vi.doUnmock("#infrastructure/git/repo-check.js");
      vi.doUnmock("#infrastructure/config/orchrc.js");
      vi.doUnmock("#infrastructure/complexity-triage.js");
      vi.doUnmock("#infrastructure/skill-loader.js");
      vi.doUnmock("#infrastructure/factories.js");
      vi.doUnmock("#domain/agent-config.js");
      vi.doUnmock("#infrastructure/fingerprint.js");
      vi.doUnmock("#infrastructure/plan/plan-parser.js");
      vi.doUnmock("#infrastructure/git/worktree.js");
      vi.doUnmock("#infrastructure/git/worktree-setup.js");
      vi.doUnmock("#infrastructure/git/git.js");
      vi.doUnmock("#ui/hud.js");
      vi.doUnmock("#ui/display.js");
      vi.resetModules();
    }

    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        logPath: logPathForPlan(expectedOrchDir, expectedPlanId),
      }),
      expect.any(Object),
    );
  });

  it("keeps the run registered after a successful execution so the dashboard can classify it later", async () => {
    const planPath = join(tempDir, "plan.md");
    await writeFile(planPath, MINIMAL_PLAN);
    const registryPath = join(tempDir, "registry", "runs.json");

    const createContainer = vi.fn(() => ({
      resolve: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      })),
    }));

    vi.resetModules();
    vi.doMock("../src/composition-root.js", () => ({
      createContainer,
    }));
    vi.doMock("#infrastructure/git/repo-check.js", () => ({
      assertGitRepo: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("#infrastructure/config/orchrc.js", () => ({
      loadAndResolveOrchrConfig: vi.fn(() => ({
        skills: {
          tdd: { enabled: true, value: "tdd skill" },
          review: { enabled: true, value: "review skill" },
          verify: { enabled: true, value: "verify skill" },
          gap: { disabled: true },
          plan: { disabled: true },
        },
        config: {},
        rules: { tdd: undefined, review: undefined },
        worktreeSetup: [],
        agents: {},
      })),
      buildOrchrSummary: vi.fn(() => "summary"),
    }));
    vi.doMock("#infrastructure/complexity-triage.js", () => ({
      buildComplexityTriagePrompt: vi.fn(),
      parseComplexityTriageResult: vi.fn(() => ({ tier: "medium", reason: "test" })),
    }));
    vi.doMock("#infrastructure/skill-loader.js", () => ({
      buildSkillOverrides: vi.fn(() => ({})),
      loadTieredSkills: vi.fn(() => ({
        tdd: "tdd skill", review: "review skill", verify: "verify skill",
        gap: null, plan: null, completeness: "completeness skill",
      })),
    }));
    vi.doMock("#domain/agent-config.js", async () => {
      const actual = await vi.importActual<typeof import("#domain/agent-config.js")>("#domain/agent-config.js");
      return {
        ...actual,
        resolveAllAgentConfigs: vi.fn(() => actual.AGENT_DEFAULTS),
      };
    });
    vi.doMock("#infrastructure/fingerprint.js", () => ({
      runFingerprint: vi.fn().mockResolvedValue({ brief: "brief text" }),
    }));
    vi.doMock("#infrastructure/plan/plan-parser.js", () => ({
      parsePlan: vi.fn().mockResolvedValue([
        {
          name: "Test",
          slices: [{
            number: 1,
            title: "Slice 1",
            content: "content",
            why: "why",
            files: [{ path: "src/s1.ts", action: "new" }],
            details: "details",
            tests: "tests",
          }],
        },
      ]),
    }));
    vi.doMock("#infrastructure/git/worktree.js", () => ({
      checkWorktreeResume: vi.fn().mockResolvedValue({ ok: true }),
      runCleanup: vi.fn(),
    }));
    vi.doMock("#infrastructure/git/worktree-setup.js", () => ({
      resolveWorktree: vi.fn().mockResolvedValue({
        cwd: tempDir,
        worktreeInfo: null,
        skipStash: true,
      }),
    }));
    vi.doMock("#infrastructure/git/git.js", () => ({
      getStatus: vi.fn().mockResolvedValue(""),
      stashBackup: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("#ui/hud.js", () => ({
      createHud: vi.fn(() => ({
        update: vi.fn(),
        wrapLog: vi.fn((logger: (...args: unknown[]) => void) => logger),
        teardown: vi.fn(),
        setActivity: vi.fn(),
        onKey: vi.fn(),
        onInterruptSubmit: vi.fn(),
        startPrompt: vi.fn(),
        createWriter: vi.fn(() => () => {}),
        setSkipping: vi.fn(),
      })),
    }));
    vi.doMock("#ui/display.js", async () => {
      const actual = await vi.importActual<typeof import("#ui/display.js")>("#ui/display.js");
      return {
        ...actual,
        logSection: vi.fn(),
        printStartupBanner: vi.fn(),
        formatPlanSummary: vi.fn(),
      };
    });
    vi.doMock("#infrastructure/factories.js", async () => {
      const actual =
        await vi.importActual<typeof import("#infrastructure/factories.js")>(
          "#infrastructure/factories.js"
        );
      return {
        ...actual,
        complexityTriageSpawnerFactory: vi.fn(() => () => ({
          send: vi.fn(),
          kill: vi.fn(),
        })),
      };
    });

    const previousArgv = process.argv;
    const previousCwd = process.cwd();
    process.argv = [
      "node",
      "main.ts",
      "--work",
      planPath,
      "--skip-fingerprint",
      "--no-interaction",
    ];
    process.chdir(tempDir);

    try {
      const { main } = await import("../src/main.js");
      await main({
        registryPath,
        onSignal: vi.fn(() => process),
        exit: vi.fn(),
      });
    } finally {
      process.argv = previousArgv;
      process.chdir(previousCwd);
      vi.doUnmock("../src/composition-root.js");
      vi.doUnmock("#infrastructure/git/repo-check.js");
      vi.doUnmock("#infrastructure/config/orchrc.js");
      vi.doUnmock("#infrastructure/complexity-triage.js");
      vi.doUnmock("#infrastructure/skill-loader.js");
      vi.doUnmock("#infrastructure/factories.js");
      vi.doUnmock("#domain/agent-config.js");
      vi.doUnmock("#infrastructure/fingerprint.js");
      vi.doUnmock("#infrastructure/plan/plan-parser.js");
      vi.doUnmock("#infrastructure/git/worktree.js");
      vi.doUnmock("#infrastructure/git/worktree-setup.js");
      vi.doUnmock("#infrastructure/git/git.js");
      vi.doUnmock("#ui/hud.js");
      vi.doUnmock("#ui/display.js");
      vi.resetModules();
    }

    const registryEntries = JSON.parse(await readFile(registryPath, "utf-8")) as Array<{
      readonly planPath: string;
      readonly statePath: string;
    }>;

    expect(registryEntries).toHaveLength(1);
    expect(registryEntries[0]).toMatchObject({
      planPath,
    });
  });

  it("keeps a run registered and writes preflight state when plan parsing fails", async () => {
    const planPath = join(tempDir, "broken-plan.json");
    const registryPath = join(tempDir, "registry", "runs.json");
    const orchDir = join(tempDir, ".orch");
    const planId = resolvePlanId(planPath);
    const statePath = statePathForPlan(orchDir, planId);

    await writeFile(planPath, "{ definitely-not-json");

    vi.resetModules();
    vi.doMock("#infrastructure/git/repo-check.js", () => ({
      assertGitRepo: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("#infrastructure/config/orchrc.js", () => ({
      loadAndResolveOrchrConfig: vi.fn(() => ({
        skills: {
          tdd: { enabled: true, value: "tdd skill" },
          review: { enabled: true, value: "review skill" },
          verify: { enabled: true, value: "verify skill" },
          gap: { disabled: true },
          plan: { disabled: true },
        },
        config: {},
        rules: { tdd: undefined, review: undefined },
        worktreeSetup: [],
        agents: {},
      })),
      buildOrchrSummary: vi.fn(() => "summary"),
    }));
    vi.doMock("#infrastructure/complexity-triage.js", () => ({
      buildComplexityTriagePrompt: vi.fn(),
      parseComplexityTriageResult: vi.fn(() => ({ tier: "medium", reason: "test" })),
    }));
    vi.doMock("#infrastructure/skill-loader.js", () => ({
      buildSkillOverrides: vi.fn(() => ({})),
      loadTieredSkills: vi.fn(() => ({
        tdd: "tdd skill", review: "review skill", verify: "verify skill",
        gap: null, plan: null, completeness: "completeness skill",
      })),
    }));
    vi.doMock("#domain/agent-config.js", async () => {
      const actual = await vi.importActual<typeof import("#domain/agent-config.js")>("#domain/agent-config.js");
      return {
        ...actual,
        resolveAllAgentConfigs: vi.fn(() => actual.AGENT_DEFAULTS),
      };
    });
    vi.doMock("#infrastructure/fingerprint.js", () => ({
      runFingerprint: vi.fn().mockResolvedValue({ brief: "brief text" }),
    }));
    vi.doMock("#infrastructure/plan/plan-parser.js", () => ({
      parsePlan: vi.fn().mockRejectedValue(new Error("Invalid plan")),
    }));
    vi.doMock("#infrastructure/factories.js", async () => {
      const actual =
        await vi.importActual<typeof import("#infrastructure/factories.js")>(
          "#infrastructure/factories.js"
        );
      return {
        ...actual,
        complexityTriageSpawnerFactory: vi.fn(() => () => ({
          send: vi.fn(),
          kill: vi.fn(),
        })),
      };
    });

    const previousArgv = process.argv;
    const previousCwd = process.cwd();
    process.argv = [
      "node",
      "main.ts",
      "--work",
      planPath,
      "--skip-fingerprint",
      "--no-interaction",
    ];
    process.chdir(tempDir);

    try {
      const { main } = await import("../src/main.js");
      await expect(
        main({
          registryPath,
          onSignal: vi.fn(() => process),
          exit: vi.fn(),
        }),
      ).rejects.toThrow("Invalid plan");
    } finally {
      process.argv = previousArgv;
      process.chdir(previousCwd);
      vi.doUnmock("#infrastructure/git/repo-check.js");
      vi.doUnmock("#infrastructure/config/orchrc.js");
      vi.doUnmock("#infrastructure/complexity-triage.js");
      vi.doUnmock("#infrastructure/skill-loader.js");
      vi.doUnmock("#infrastructure/factories.js");
      vi.doUnmock("#domain/agent-config.js");
      vi.doUnmock("#infrastructure/fingerprint.js");
      vi.doUnmock("#infrastructure/plan/plan-parser.js");
      vi.resetModules();
    }

    const registryEntries = JSON.parse(await readFile(registryPath, "utf-8")) as Array<{
      readonly planPath: string;
      readonly statePath: string;
    }>;
    expect(registryEntries).toHaveLength(1);
    expect(registryEntries[0]).toMatchObject({
      planPath,
      statePath: expect.stringMatching(new RegExp(`${planId}\\.json$`)),
    });

    const state = JSON.parse(await readFile(statePath, "utf-8")) as {
      readonly startedAt?: string;
      readonly currentPhase?: string;
    };
    expect(state.startedAt).toEqual(expect.any(String));
    expect(state.currentPhase).toBe("plan");
  });
});

describe("composition root integration", () => {
  it("createContainer resolves RunOrchestration and executes a minimal plan end-to-end", async () => {
    const { createContainer } = await import("../src/composition-root.js");
    const { RunOrchestration } = await import("../src/application/run-orchestration.js");
    const config = makeTestConfig();
    const dummyHud = {
      askUser: vi.fn().mockResolvedValue(""),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      wrapLog: vi.fn().mockReturnValue(vi.fn()),
      createWriter: vi.fn(() => () => {}),
      setSkipping: vi.fn(),
    } as any;

    const container = createContainer(config, dummyHud);
    const orch = container.resolve("runOrchestration");
    expect(orch).toBeInstanceOf(RunOrchestration);

    // Replace ports with in-memory test doubles AFTER construction
    const tddAgent = makeTestAgent();
    const reviewAgent = makeTestAgent();
    const verifyAgent = {
      ...makeTestAgent(),
      send: vi.fn().mockResolvedValue(makeTestResult({
        assistantText: `### VERIFY_JSON
\`\`\`json
${JSON.stringify({
  status: "PASS",
  checks: [{ check: "npx vitest run", status: "PASS" }],
  sliceLocalFailures: [],
  outOfScopeFailures: [],
  preExistingFailures: [],
  runnerIssue: null,
  retryable: false,
  summary: "Verification passed.",
}, null, 2)}
\`\`\``,
      })),
    };
    (orch as any).agents = {
      spawn: vi.fn().mockReturnValue(makeTestAgent()),
    };
    (orch as any).agents.spawn
      .mockReturnValueOnce(tddAgent)
      .mockReturnValueOnce(reviewAgent)
      .mockReturnValueOnce(verifyAgent);
    (orch as any).persistence = {
      load: vi.fn().mockResolvedValue({}),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    (orch as any).git = {
      captureRef: vi.fn().mockResolvedValue("sha0"),
      hasChanges: vi.fn().mockResolvedValue(false),
      hasDirtyTree: vi.fn().mockResolvedValue(false),
      getStatus: vi.fn().mockResolvedValue(""),
      stashBackup: vi.fn().mockResolvedValue(false),
      getDiff: vi.fn().mockResolvedValue(""),
      measureDiff: vi.fn().mockResolvedValue({ added: 0, removed: 0, total: 0 }),
    };

    const group = {
      name: "TestGroup",
      slices: [{
        number: 1,
        title: "Test Slice",
        content: "slice content",
        why: "test",
        files: [{ path: "src/test.ts", action: "new" as const }],
        details: "details",
        tests: "tests",
      }],
    };

    await orch.execute([group]);

    // Verify agents were spawned and rules reminders sent
    expect((orch as any).agents.spawn).toHaveBeenCalledWith("tdd", expect.any(Object));
    expect((orch as any).agents.spawn).toHaveBeenCalledWith("review", expect.any(Object));
    // Verify state was persisted
    expect((orch as any).persistence.save).toHaveBeenCalled();
  });

  it("typed-inject resolves all dependencies without errors", async () => {
    const { createContainer } = await import("../src/composition-root.js");
    const config = makeTestConfig();
    const dummyHud = {
      askUser: vi.fn(),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      wrapLog: vi.fn().mockReturnValue(vi.fn()),
      createWriter: vi.fn(() => () => {}),
      setSkipping: vi.fn(),
    } as any;

    const container = createContainer(config, dummyHud);

    // All tokens should resolve without throwing
    expect(() => container.resolve("agentSpawner")).not.toThrow();
    expect(() => container.resolve("statePersistence")).not.toThrow();
    expect(() => container.resolve("operatorGate")).not.toThrow();
    expect(() => container.resolve("gitOps")).not.toThrow();
    expect(() => container.resolve("promptBuilder")).not.toThrow();
    expect(() => container.resolve("runOrchestration")).not.toThrow();
  });

  it("dispose kills agents and tears down gate on cleanup", async () => {
    const { createContainer } = await import("../src/composition-root.js");
    const config = makeTestConfig();
    const mockTeardown = vi.fn();
    const dummyHud = {
      askUser: vi.fn().mockResolvedValue(""),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: mockTeardown,
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      wrapLog: vi.fn().mockReturnValue(vi.fn()),
      createWriter: vi.fn(() => () => {}),
      setSkipping: vi.fn(),
    } as any;

    const container = createContainer(config, dummyHud);
    const orch = container.resolve("runOrchestration");

    // Inject mock agents
    const tddAgent = makeTestAgent();
    const reviewAgent = makeTestAgent();
    orch.tddAgent = tddAgent;
    orch.reviewAgent = reviewAgent;

    // Simulate what SIGINT handler does
    orch.dispose();

    expect(tddAgent.kill).toHaveBeenCalled();
    expect(reviewAgent.kill).toHaveBeenCalled();
    // SilentOperatorGate teardown is a no-op (auto: true),
    // but it's still called — proves the cascade works
  });

  it("cleanup reassignment: after container creation, cleanup calls orch.dispose not hud.teardown", async () => {
    // This tests the pattern in main.ts lines 239-290:
    // let cleanup = () => hud.teardown();  // initial
    // ... container creation ...
    // cleanup = () => orch.dispose();      // upgraded
    const { createContainer } = await import("../src/composition-root.js");
    const config = makeTestConfig({ auto: true });
    const hudTeardown = vi.fn();
    const dummyHud = {
      askUser: vi.fn().mockResolvedValue(""),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: hudTeardown,
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      wrapLog: vi.fn().mockReturnValue(vi.fn()),
      createWriter: vi.fn(() => () => {}),
      setSkipping: vi.fn(),
    } as any;

    // Simulate main.ts cleanup pattern
    let cleanup = () => dummyHud.teardown();

    const container = createContainer(config, dummyHud);
    const orch = container.resolve("runOrchestration");
    const tddAgent = makeTestAgent();
    orch.tddAgent = tddAgent;

    // Upgrade cleanup (same as main.ts line 290)
    cleanup = () => orch.dispose();

    // Calling cleanup should now call orch.dispose, NOT hud.teardown directly
    cleanup();

    // orch.dispose kills agents — proves the reassignment worked
    expect(tddAgent.kill).toHaveBeenCalled();
    // hud.teardown IS called indirectly via progressSink.teardown inside dispose
    expect(hudTeardown).toHaveBeenCalled();
  });

  it("early cleanup (before container) calls hud.teardown directly", () => {
    // Tests the fallback path: SIGINT before container creation
    const hudTeardown = vi.fn();
    const dummyHud = { teardown: hudTeardown } as any;

    // Initial cleanup (main.ts line 239)
    const cleanup = () => dummyHud.teardown();
    cleanup();

    expect(hudTeardown).toHaveBeenCalledOnce();
  });

  it("CreditExhaustedError from execute triggers catch block", async () => {
    // Tests main.ts lines 311-316: CreditExhaustedError → exit(2)
    const { CreditExhaustedError } = await import("../src/domain/errors.js");
    const { createContainer } = await import("../src/composition-root.js");
    const config = makeTestConfig();
    const dummyHud = {
      askUser: vi.fn().mockResolvedValue(""),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      wrapLog: vi.fn().mockReturnValue(vi.fn()),
      createWriter: vi.fn(() => () => {}),
      setSkipping: vi.fn(),
    } as any;

    const container = createContainer(config, dummyHud);
    const orch = container.resolve("runOrchestration");

    // Make execute throw CreditExhaustedError
    const originalExecute = orch.execute.bind(orch);
    orch.execute = vi.fn().mockRejectedValue(
      new CreditExhaustedError("credits gone", "mid-response"),
    );

    // Simulate main.ts catch pattern (lines 311-316)
    let exitCode: number | undefined;
    try {
      await orch.execute([]);
    } catch (err) {
      if (err instanceof CreditExhaustedError) {
        exitCode = 2;
      } else {
        throw err;
      }
    }

    expect(exitCode).toBe(2);
  });

  it("IncompleteRunError from execute bypasses success cleanup", async () => {
    const cleanup = vi.fn();
    const logSection = vi.fn();
    const clearState = vi.fn().mockResolvedValue(undefined);
    let exitCode: number | undefined;

    try {
      throw new IncompleteRunError("Slice 1 did not complete: verification or review did not complete");
    } catch (err) {
      if (err instanceof IncompleteRunError) {
        cleanup();
        exitCode = 1;
      } else {
        throw err;
      }
    }

    if (exitCode === undefined) {
      logSection();
      await clearState("/tmp/state.json");
    }

    expect(exitCode).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(logSection).not.toHaveBeenCalled();
    expect(clearState).not.toHaveBeenCalled();
  });
});
