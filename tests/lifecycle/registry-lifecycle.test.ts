import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
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
  getStatus: vi.fn(),
  loadAndResolveOrchrConfig: vi.fn(),
  loadState: vi.fn(),
  parseBranchFlag: vi.fn(),
  parsePlan: vi.fn(),
  parseProviderFlag: vi.fn(),
  resolveAllAgentConfigs: vi.fn(),
  resolveSkillValue: vi.fn(),
  resolveWorktree: vi.fn(),
  runFingerprint: vi.fn(),
  stashBackup: vi.fn(),
  statePathForPlan: vi.fn(),
}));

vi.mock("#domain/agent-config.js", () => ({
  resolveAllAgentConfigs: mocks.resolveAllAgentConfigs,
}));

vi.mock("#infrastructure/cli/cli-args.js", () => ({
  parseBranchFlag: mocks.parseBranchFlag,
  parseProviderFlag: mocks.parseProviderFlag,
}));

vi.mock("#infrastructure/config/orchrc.js", () => ({
  buildOrchrSummary: mocks.buildOrchrSummary,
  loadAndResolveOrchrConfig: mocks.loadAndResolveOrchrConfig,
  resolveSkillValue: mocks.resolveSkillValue,
}));

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
  isPlanFormat: vi.fn(),
  planGeneratorSpawnerFactory: vi.fn(),
}));

vi.mock("#infrastructure/plan/plan-parser.js", () => ({
  parsePlan: mocks.parsePlan,
}));

vi.mock("#infrastructure/state/state.js", () => ({
  clearState: mocks.clearState,
  loadState: mocks.loadState,
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

vi.mock("../../src/composition-root.ts", () => ({
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
  mocks.resolveSkillValue.mockImplementation((_resolved, builtIn: string) => builtIn);
  mocks.buildOrchrSummary.mockReturnValue(undefined);
  mocks.runFingerprint.mockResolvedValue({ brief: "brief" });
  mocks.parseProviderFlag.mockReturnValue("claude");
  mocks.resolveAllAgentConfigs.mockReturnValue({});
  mocks.ensureCanonicalPlan.mockReturnValue("abc123");
  mocks.parseBranchFlag.mockReturnValue("feature/test");
  mocks.statePathForPlan.mockReturnValue(statePath);
  mocks.clearState.mockResolvedValue(undefined);
  mocks.loadState.mockResolvedValue({});
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

    const { main } = await import("../../src/main.ts");
    const mainPromise = main({
      onSignal: () => process,
      registryPath,
    });

    await started.promise;

    const entries = await readRegistry(registryPath);
    expect(entries).toEqual([
      {
        id: "abc123",
        pid: process.pid,
        repo: process.cwd(),
        planPath,
        statePath,
        branch: "feature/test",
        startedAt: expect.any(String),
      },
    ]);

    release.resolve();
    await mainPromise;
  });

  it("registry entry is removed on clean exit", async () => {
    const orch = {
      dispose: vi.fn(),
      execute: vi.fn(async (_groups: unknown, opts: { onReady: (info: { tddSessionId: string; reviewSessionId: string }) => void }) => {
        opts.onReady({ reviewSessionId: "review-session", tddSessionId: "tdd-session" });
      }),
    };
    mocks.createContainer.mockReturnValue({
      resolve: vi.fn(() => orch),
    });

    const { main } = await import("../../src/main.ts");
    await main({
      onSignal: () => process,
      registryPath,
    });

    const entries = await readRegistry(registryPath);
    expect(entries).toEqual([]);
  });

  it("registry entry is removed when SIGTERM is received", async () => {
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

    const mainModule = await import("../../src/main.ts");
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
    let entries = await readRegistry(registryPath);
    const deadline = Date.now() + 1_000;
    while (entries.length > 0 && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      entries = await readRegistry(registryPath);
    }
    expect(entries).toEqual([]);

    release.resolve();
    await mainPromise;
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("registry entry is removed when SIGINT is received", async () => {
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

    const mainModule = await import("../../src/main.ts");
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
    let entries = await readRegistry(registryPath);
    const deadline = Date.now() + 1_000;
    while (entries.length > 0 && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      entries = await readRegistry(registryPath);
    }
    expect(entries).toEqual([]);

    release.resolve();
    await mainPromise;
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("registry entry is removed when orchestration exits through the error catch path", async () => {
    const { IncompleteRunError } = await import("../../src/domain/errors.ts");
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

    const mainModule = await import("../../src/main.ts");
    const main = mainModule.main as (runtime?: MainTestRuntime) => Promise<void>;

    await expect(main({ registryPath, onSignal: () => process, exit })).resolves.toBeUndefined();

    const entries = await readRegistry(registryPath);
    expect(entries).toEqual([]);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
