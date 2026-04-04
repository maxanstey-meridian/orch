import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRegistry } from "#infrastructure/registry/run-registry.js";

const mocks = vi.hoisted(() => ({
  assertGitRepo: vi.fn(),
  buildOrchrSummary: vi.fn(),
  checkWorktreeResume: vi.fn(),
  clearState: vi.fn(),
  createContainer: vi.fn(),
  createHud: vi.fn(),
  ensureCanonicalPlan: vi.fn(),
  generatePlanId: vi.fn(),
  getStatus: vi.fn(),
  isPlanFormat: vi.fn(),
  loadAndResolveOrchrConfig: vi.fn(),
  loadState: vi.fn(),
  parseBranchFlag: vi.fn(),
  parseExecutionPreference: vi.fn(),
  parsePlan: vi.fn(),
  parseProviderFlag: vi.fn(),
  planFileName: vi.fn(),
  resolvePlanId: vi.fn(),
  resolveAllAgentConfigs: vi.fn(),
  loadTieredSkills: vi.fn(),
  buildSkillOverrides: vi.fn(),
  resolveWorktree: vi.fn(),
  runFingerprint: vi.fn(),
  saveState: vi.fn(),
  stashBackup: vi.fn(),
  statePathForPlan: vi.fn(),
}));

vi.mock("#domain/agent-config.js", () => ({
  resolveAllAgentConfigs: mocks.resolveAllAgentConfigs,
}));

vi.mock("#infrastructure/cli/cli-args.js", () => ({
  parseBranchFlag: mocks.parseBranchFlag,
  parseExecutionPreference: mocks.parseExecutionPreference,
  parseProviderFlag: mocks.parseProviderFlag,
}));

vi.mock("#infrastructure/config/orchrc.js", () => ({
  buildOrchrSummary: mocks.buildOrchrSummary,
  loadAndResolveOrchrConfig: mocks.loadAndResolveOrchrConfig,
}));

vi.mock("#infrastructure/complexity-triage.js", () => ({
  buildComplexityTriagePrompt: vi.fn(),
  parseComplexityTriageResult: vi.fn(() => ({ tier: "medium", reason: "test" })),
}));

vi.mock("#infrastructure/skill-loader.js", () => ({
  buildSkillOverrides: mocks.buildSkillOverrides,
  loadTieredSkills: mocks.loadTieredSkills,
}));

vi.mock("#infrastructure/factories.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#infrastructure/factories.js")>();
  return {
    ...actual,
    complexityTriageSpawnerFactory: vi.fn(() => () => ({
      send: vi.fn(),
      kill: vi.fn(),
    })),
  };
});

vi.mock("#infrastructure/fingerprint.js", () => ({
  runFingerprint: mocks.runFingerprint,
}));

vi.mock("#infrastructure/git/git.js", () => ({
  getStatus: mocks.getStatus,
  stashBackup: mocks.stashBackup,
}));

vi.mock("#infrastructure/git/repo-check.js", () => ({
  assertGitRepo: mocks.assertGitRepo,
}));

vi.mock("#infrastructure/git/worktree-setup.js", () => ({
  resolveWorktree: mocks.resolveWorktree,
}));

vi.mock("#infrastructure/git/worktree.js", () => ({
  checkWorktreeResume: mocks.checkWorktreeResume,
  runCleanup: vi.fn(),
}));

vi.mock("#infrastructure/plan/plan-generator.js", () => ({
  doGeneratePlan: vi.fn(),
  ensureCanonicalPlan: mocks.ensureCanonicalPlan,
  generatePlanId: mocks.generatePlanId,
  isPlanFormat: mocks.isPlanFormat,
  planGeneratorSpawnerFactory: vi.fn(),
  planFileName: mocks.planFileName,
  resolvePlanId: mocks.resolvePlanId,
}));

vi.mock("#infrastructure/plan/plan-parser.js", () => ({
  parsePlan: mocks.parsePlan,
}));

vi.mock("#infrastructure/state/state.js", () => ({
  clearState: mocks.clearState,
  loadState: mocks.loadState,
  saveState: mocks.saveState,
  statePathForPlan: mocks.statePathForPlan,
}));

vi.mock("#ui/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#ui/display.js")>();
  return {
    ...actual,
    formatPlanSummary: vi.fn(),
    logSection: vi.fn(),
    printStartupBanner: vi.fn(),
    ts: vi.fn(() => ""),
  };
});

vi.mock("#ui/hud.js", () => ({
  createHud: mocks.createHud,
}));

vi.mock("../../src/composition-root.js", () => ({
  createContainer: mocks.createContainer,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

type MainTestRuntime = {
  registryPath: string;
  onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => NodeJS.Process;
  exit?: (code: number) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const originalCwd = process.cwd();
const originalArgv = [...process.argv];

let tempDir: string;
let registryPath: string;
let planPath: string;
let statePath: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  tempDir = await mkdtemp(join(tmpdir(), "orch-registry-lifecycle-"));
  registryPath = join(tempDir, ".orch", "runs.json");
  planPath = join(tempDir, "plan.json");
  statePath = join(tempDir, ".orch", "state", "plan-abc123.json");

  await mkdir(join(tempDir, ".orch", "state"), { recursive: true });
  await writeFile(
    planPath,
    JSON.stringify({
      groups: [
        {
          name: "Registry",
          slices: [
            {
              number: 1,
              title: "Slice",
              why: "Test main lifecycle.",
              files: [{ path: "src/main.ts", action: "edit" }],
              details: "Test details.",
              tests: "Test lifecycle.",
            },
          ],
        },
      ],
    }),
  );

  process.chdir(tempDir);
  process.argv = ["node", "/virtual/main.ts", "--work", planPath, "--skip-fingerprint", "--no-interaction"];

  mocks.assertGitRepo.mockResolvedValue(undefined);
  mocks.loadAndResolveOrchrConfig.mockReturnValue({
    skills: {
      tdd: { default: true },
      review: { default: true },
      verify: { default: true },
      gap: { default: true },
      plan: { default: true },
    },
    rules: {},
    config: {},
    agents: undefined,
  });
  mocks.loadTieredSkills.mockReturnValue({
    tdd: "tdd-skill", review: "review-skill", verify: "verify-skill",
    gap: "gap-skill", plan: "plan-skill", completeness: "completeness-skill",
  });
  mocks.buildSkillOverrides.mockReturnValue({});
  mocks.buildOrchrSummary.mockReturnValue(undefined);
  mocks.runFingerprint.mockResolvedValue({ brief: "brief" });
  mocks.parseProviderFlag.mockReturnValue("claude");
  mocks.parseExecutionPreference.mockReturnValue("auto");
  mocks.resolveAllAgentConfigs.mockReturnValue({});
  mocks.planFileName.mockImplementation((id: string) => `plan-${id}.json`);
  mocks.resolvePlanId.mockReturnValue("abc123");
  mocks.generatePlanId.mockReturnValue("direct42");
  mocks.ensureCanonicalPlan.mockReturnValue("abc123");
  mocks.parseBranchFlag.mockReturnValue("feature/test");
  mocks.statePathForPlan.mockReturnValue(statePath);
  mocks.clearState.mockResolvedValue(undefined);
  mocks.loadState.mockResolvedValue({});
  mocks.saveState.mockResolvedValue(undefined);
  mocks.parsePlan.mockResolvedValue([
    {
      name: "Registry",
      slices: [{ number: 1, title: "Slice", content: "content" }],
    },
  ]);
  mocks.createHud.mockReturnValue({
    createWriter: vi.fn(),
    onInterruptSubmit: vi.fn(),
    onKey: vi.fn(),
    setActivity: vi.fn(),
    setSkipping: vi.fn(),
    startPrompt: vi.fn(),
    teardown: vi.fn(),
    update: vi.fn(),
    wrapLog: vi.fn((fn: (...args: unknown[]) => void) => fn),
  });
  mocks.checkWorktreeResume.mockResolvedValue({ ok: true });
  mocks.resolveWorktree.mockResolvedValue({
    cwd: tempDir,
    skipStash: true,
    worktreeInfo: undefined,
  });
  mocks.stashBackup.mockResolvedValue(false);
  mocks.getStatus.mockResolvedValue("clean");
  mocks.isPlanFormat.mockReturnValue(false);
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.argv = [...originalArgv];
  await rm(tempDir, { recursive: true, force: true });
});

describe("registry lifecycle", () => {
  it("registry file is created on orchestration start", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const orch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session", tddSessionId: "tdd-session" });
        started.resolve();
        await release.promise;
      }),
    };
    mocks.createContainer.mockReturnValue({
      resolve: vi.fn(() => orch),
    });

    const { main } = await import("../../src/main.js");
    const mainPromise = main({
      onSignal: () => process,
      registryPath,
    });

    await started.promise;

    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: expect.any(String),
      pid: process.pid,
      repo: process.cwd(),
      planPath,
      statePath,
      branch: "feature/test",
      startedAt: expect.any(String),
    });

    release.resolve();
    await mainPromise;
  });

  it("registry entry remains after clean exit", async () => {
    const orch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session", tddSessionId: "tdd-session" });
      }),
    };
    mocks.createContainer.mockReturnValue({
      resolve: vi.fn(() => orch),
    });

    const { main } = await import("../../src/main.js");
    await main({
      onSignal: () => process,
      registryPath,
    });

    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        planPath,
        statePath,
        branch: "feature/test",
      }),
    );
  });

  it("registry entry remains when SIGTERM is received", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const signalHandlers = new Map<string, () => void>();
    const exit = vi.fn();
    const orch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session", tddSessionId: "tdd-session" });
        started.resolve();
        await release.promise;
      }),
    };
    mocks.createContainer.mockReturnValue({
      resolve: vi.fn(() => orch),
    });

    const mainModule = await import("../../src/main.js");
    const main = mainModule.main as (runtime?: MainTestRuntime) => Promise<void>;
    const mainPromise = main({
      registryPath,
      onSignal: (signal, handler) => {
        signalHandlers.set(signal, handler);
        return process;
      },
      exit,
    });

    await started.promise;

    expect(signalHandlers.has("SIGTERM")).toBe(true);
    signalHandlers.get("SIGTERM")?.();
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({ planPath, statePath }));

    release.resolve();
    await mainPromise;
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("registry entry remains when SIGINT is received", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const signalHandlers = new Map<string, () => void>();
    const exit = vi.fn();
    const orch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session", tddSessionId: "tdd-session" });
        started.resolve();
        await release.promise;
      }),
    };
    mocks.createContainer.mockReturnValue({
      resolve: vi.fn(() => orch),
    });

    const mainModule = await import("../../src/main.js");
    const main = mainModule.main as (runtime?: MainTestRuntime) => Promise<void>;
    const mainPromise = main({
      registryPath,
      onSignal: (signal, handler) => {
        signalHandlers.set(signal, handler);
        return process;
      },
      exit,
    });

    await started.promise;

    expect(signalHandlers.has("SIGINT")).toBe(true);
    signalHandlers.get("SIGINT")?.();
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({ planPath, statePath }));

    release.resolve();
    await mainPromise;
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("registry entry remains when orchestration exits through the error catch path", async () => {
    const { IncompleteRunError } = await import("../../src/domain/errors.js");
    const exit = vi.fn();
    const orch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session", tddSessionId: "tdd-session" });
        throw new IncompleteRunError("stop here");
      }),
    };
    mocks.createContainer.mockReturnValue({
      resolve: vi.fn(() => orch),
    });

    const mainModule = await import("../../src/main.js");
    const main = mainModule.main as (runtime?: MainTestRuntime) => Promise<void>;

    await expect(main({ registryPath, onSignal: () => process, exit })).resolves.toBeUndefined();

    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({ planPath, statePath }));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("registry entry remains when setup fails before orchestration starts", async () => {
    mocks.createContainer.mockImplementation(() => {
      throw new Error("container failed");
    });

    const { main } = await import("../../src/main.js");

    await expect(main({
      onSignal: () => process,
      registryPath,
    })).rejects.toThrow("container failed");

    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({ planPath, statePath }));
  });

  it("direct inventory runs register and clean up through the shared signal path", async () => {
    const inventoryPath = join(tempDir, "inventory.md");
    await writeFile(inventoryPath, "# Feature Inventory\n\n- Direct change\n");
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const signalHandlers = new Map<string, () => void>();
    const exit = vi.fn();
    const orch = {
      dispose: vi.fn(),
      execute: vi.fn(async () => {
        started.resolve();
        await release.promise;
      }),
    };
    mocks.resolveAllAgentConfigs.mockReturnValue({
      plan: { provider: "claude" },
    });
    mocks.parseExecutionPreference.mockReturnValue("quick");
    mocks.createContainer.mockReturnValue({
      resolve: vi.fn(() => orch),
    });
    process.argv = [
      "node",
      "/virtual/main.ts",
      "--plan",
      inventoryPath,
      "--skip-fingerprint",
      "--no-interaction",
      "--quick",
    ];

    const mainModule = await import("../../src/main.js");
    const main = mainModule.main as (runtime?: MainTestRuntime) => Promise<void>;
    const mainPromise = main({
      registryPath,
      onSignal: (signal, handler) => {
        signalHandlers.set(signal, handler);
        return process;
      },
      exit,
    });

    await started.promise;

    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        planPath: expect.stringMatching(/\.orch\/plan-direct42\.json$/),
      }),
    );
    expect(mocks.generatePlanId).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePlanId).not.toHaveBeenCalled();
    const registeredPlan = JSON.parse(await readFile(entries[0].planPath, "utf-8")) as {
      readonly groups: ReadonlyArray<{
        readonly name: string;
        readonly slices: ReadonlyArray<{ readonly title: string }>;
      }>;
    };
    expect(registeredPlan.groups[0]?.name).toBe("Direct");
    expect(registeredPlan.groups[0]?.slices[0]?.title).toBe("Direct request");
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    signalHandlers.get("SIGTERM")?.();
    expect(orch.dispose).toHaveBeenCalledTimes(1);

    release.resolve();
    await mainPromise;
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("show-plan exits before writing preflight state or registry entries", async () => {
    const exit = vi.fn();
    process.argv = [
      "node",
      "/virtual/main.ts",
      "--work",
      planPath,
      "--skip-fingerprint",
      "--no-interaction",
      "--show-plan",
    ];

    const { main } = await import("../../src/main.js");
    await main({
      onSignal: () => process,
      registryPath,
      exit,
    });

    const entries = await readRegistry(registryPath);
    expect(entries).toEqual([]);
    expect(mocks.saveState).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("concurrent runs of the same plan keep distinct registry identities", async () => {
    const startedFirst = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const startedSecond = createDeferred<void>();
    const releaseSecond = createDeferred<void>();
    const firstOrch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session-1", tddSessionId: "tdd-session-1" });
        startedFirst.resolve();
        await releaseFirst.promise;
      }),
    };
    const secondOrch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session-2", tddSessionId: "tdd-session-2" });
        startedSecond.resolve();
        await releaseSecond.promise;
      }),
    };
    mocks.createContainer.mockReturnValueOnce({
      resolve: vi.fn(() => firstOrch),
    }).mockReturnValueOnce({
      resolve: vi.fn(() => secondOrch),
    });

    const { main } = await import("../../src/main.js");
    const firstMain = main({
      onSignal: () => process,
      registryPath,
    });

    await startedFirst.promise;

    const secondMain = main({
      onSignal: () => process,
      registryPath,
    });

    await startedSecond.promise;

    const entriesDuringBothRuns = await readRegistry(registryPath);
    expect(entriesDuringBothRuns).toHaveLength(2);
    expect(new Set(entriesDuringBothRuns.map((entry) => entry.id)).size).toBe(2);

    releaseFirst.resolve();
    await firstMain;

    const entriesAfterFirstCleanup = await readRegistry(registryPath);
    expect(entriesAfterFirstCleanup).toHaveLength(2);
    expect(new Set(entriesAfterFirstCleanup.map((entry) => entry.id)).size).toBe(2);

    releaseSecond.resolve();
    await secondMain;

    const entriesAfterSecondCleanup = await readRegistry(registryPath);
    expect(entriesAfterSecondCleanup).toHaveLength(2);
    expect(new Set(entriesAfterSecondCleanup.map((entry) => entry.id)).size).toBe(2);
  });

  it("serializes registry mutations for a shared registry path", async () => {
    const startedFirst = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    let secondEntered = false;

    const mainModule = await import("../../src/main.js");
    const withRegistryLock = (mainModule as { withRegistryLock?: (path: string, work: () => Promise<void>) => Promise<void> }).withRegistryLock;

    expect(withRegistryLock).toBeTypeOf("function");

    const first = withRegistryLock!(registryPath, async () => {
      startedFirst.resolve();
      await releaseFirst.promise;
    });

    await startedFirst.promise;

    const second = withRegistryLock!(registryPath, async () => {
      secondEntered = true;
    });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    await first;
    await second;
    expect(secondEntered).toBe(true);
  });

  it("re-exports the shared registry lock implementation from main", async () => {
    const mainModule = await import("../../src/main.js");
    const registryModule = await import("#infrastructure/registry/run-registry.js");

    expect(mainModule.withRegistryLock).toBe(registryModule.withRegistryLock);
  });

  it("releases the registry lock when the callback throws", async () => {
    const mainModule = await import("../../src/main.js");
    const withRegistryLock = (mainModule as {
      withRegistryLock?: (path: string, work: () => Promise<void>) => Promise<void>;
    }).withRegistryLock;
    let secondEntered = false;

    await expect(
      withRegistryLock!(registryPath, async () => {
        throw new Error("lock callback failed");
      }),
    ).rejects.toThrow("lock callback failed");

    await withRegistryLock!(registryPath, async () => {
      secondEntered = true;
    });

    expect(secondEntered).toBe(true);
  });

  it("creates the registry parent directory before acquiring the lock", async () => {
    const mainModule = await import("../../src/main.js");
    const withRegistryLock = (mainModule as {
      withRegistryLock?: (path: string, work: () => Promise<void>) => Promise<void>;
    }).withRegistryLock;
    const missingRegistryPath = join(tempDir, "missing", ".orch", "runs.json");
    let entered = false;

    await withRegistryLock!(missingRegistryPath, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
  });

  it("recovers a stale dead-owner lock directory", async () => {
    const mainModule = await import("../../src/main.js");
    const withRegistryLock = (mainModule as {
      withRegistryLock?: (path: string, work: () => Promise<void>) => Promise<void>;
    }).withRegistryLock;
    const staleRegistryPath = join(tempDir, "stale", ".orch", "runs.json");
    const lockPath = `${staleRegistryPath}.lock`;
    let entered = false;

    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        acquiredAt: "2000-01-01T00:00:00.000Z",
        pid: 999999,
      }),
    );

    const pending = withRegistryLock!(staleRegistryPath, async () => {
      entered = true;
    });
    const result = await Promise.race([
      pending.then(() => "entered"),
      new Promise<"timeout">((resolveDelay) => setTimeout(() => resolveDelay("timeout"), 75)),
    ]);

    if (result === "timeout") {
      await rm(lockPath, { force: true, recursive: true });
      await pending;
    }

    expect(result).toBe("entered");
    expect(entered).toBe(true);
  });

  it("recovers a stale lock directory without owner metadata", async () => {
    const mainModule = await import("../../src/main.js");
    const withRegistryLock = (mainModule as {
      withRegistryLock?: (path: string, work: () => Promise<void>) => Promise<void>;
    }).withRegistryLock;
    const staleRegistryPath = join(tempDir, "stale-no-owner", ".orch", "runs.json");
    const lockPath = `${staleRegistryPath}.lock`;
    let entered = false;

    await mkdir(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 61_000);
    await utimes(lockPath, staleTime, staleTime);

    await withRegistryLock!(staleRegistryPath, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
  });
});
