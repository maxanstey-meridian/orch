import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";

const mocks = vi.hoisted(() => ({
  addToQueue: vi.fn(),
  agentSpawnerFactorySpy: vi.fn(),
  aggregateDashboard: vi.fn(),
  assertGitRepo: vi.fn(),
  auditContextInBackground: vi.fn(),
  buildOrchrSummary: vi.fn(),
  buildSkillOverrides: vi.fn(),
  createHud: vi.fn(),
  defaultQueuePath: vi.fn(),
  doGeneratePlan: vi.fn(),
  executeGroups: vi.fn(),
  loadAndResolveOrchrConfig: vi.fn(),
  loadTieredSkills: vi.fn(),
  parseExecutionPreference: vi.fn(),
  parseProviderFlag: vi.fn(),
  parseTreeFlag: vi.fn(),
  readQueue: vi.fn(),
  removeFromQueue: vi.fn(),
  renderDashboard: vi.fn(),
  resolveAllAgentConfigs: vi.fn(),
  runFingerprint: vi.fn(),
}));

vi.mock("#domain/agent-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#domain/agent-config.js")>();
  return {
    ...actual,
    resolveAllAgentConfigs: mocks.resolveAllAgentConfigs,
  };
});

vi.mock("#infrastructure/cli/cli-args.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#infrastructure/cli/cli-args.js")>();
  return {
    ...actual,
    parseExecutionPreference: mocks.parseExecutionPreference,
    parseProviderFlag: mocks.parseProviderFlag,
    parseTreeFlag: mocks.parseTreeFlag,
  };
});

vi.mock("#infrastructure/config/orchrc.js", () => ({
  buildOrchrSummary: mocks.buildOrchrSummary,
  loadAndResolveOrchrConfig: mocks.loadAndResolveOrchrConfig,
}));

vi.mock("#infrastructure/context/context-auditor.js", () => ({
  auditContextInBackground: mocks.auditContextInBackground,
}));

vi.mock("#infrastructure/dashboard/data-aggregator.js", () => ({
  aggregateDashboard: mocks.aggregateDashboard,
}));

vi.mock("#infrastructure/fingerprint.js", () => ({
  runFingerprint: mocks.runFingerprint,
}));

vi.mock("#infrastructure/git/repo-check.js", () => ({
  assertGitRepo: mocks.assertGitRepo,
}));

vi.mock("#infrastructure/plan/plan-generator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#infrastructure/plan/plan-generator.js")>();
  return {
    ...actual,
    doGeneratePlan: mocks.doGeneratePlan,
  };
});

vi.mock("#infrastructure/prompts/skill-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#infrastructure/prompts/skill-loader.js")>();
  return {
    ...actual,
    buildSkillOverrides: mocks.buildSkillOverrides,
    loadTieredSkills: mocks.loadTieredSkills,
  };
});

vi.mock("#infrastructure/queue/queue-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#infrastructure/queue/queue-store.js")>();
  return {
    ...actual,
    addToQueue: mocks.addToQueue,
    defaultQueuePath: mocks.defaultQueuePath,
    readQueue: mocks.readQueue,
    removeFromQueue: mocks.removeFromQueue,
  };
});

vi.mock("#ui/dashboard/dashboard-app.js", () => ({
  renderDashboard: mocks.renderDashboard,
}));

vi.mock("#ui/hud.js", () => ({
  createHud: mocks.createHud,
}));

vi.mock("#application/pipeline/execution-router.js", () => ({
  executeGroups: mocks.executeGroups,
}));

vi.mock("#infrastructure/factories.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#infrastructure/factories.js")>();
  mocks.agentSpawnerFactorySpy.mockImplementation(() => ({
    spawn: (role: string) => ({
      sessionId: `${role}-session`,
      style: { label: role, color: "white", badge: role },
      alive: true,
      stderr: "",
      send: vi.fn(async () => ({
        exitCode: 0,
        assistantText: "",
        resultText: "",
        needsInput: false,
        sessionId: `${role}-session`,
      })),
      sendQuiet: vi.fn(async () => ""),
      inject: vi.fn(),
      kill: vi.fn(),
      pipe: vi.fn(),
    }),
  }));
  return {
    ...actual,
    agentSpawnerFactory: mocks.agentSpawnerFactorySpy,
  };
});

const originalArgv = [...process.argv];
const originalCwd = process.cwd();

let tempDir: string;
let queuePath: string;
let registryPath: string;

const makeHud = () => ({
  askUser: vi.fn(),
  createWriter: vi.fn(() => vi.fn()),
  onInterruptSubmit: vi.fn(),
  onKey: vi.fn(),
  setActivity: vi.fn(),
  setSkipping: vi.fn(),
  startPrompt: vi.fn(),
  teardown: vi.fn(),
  update: vi.fn(),
  wrapLog: vi.fn((logFn: (...args: unknown[]) => void) => logFn),
});

const invokeMain = async (): Promise<void> => {
  const { main } = await import("../../src/main.js");
  await main({
    onSignal: () => process,
    exit: vi.fn(),
    registryPath,
  });
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  tempDir = await mkdtemp(join(tmpdir(), "orch-main-subcommands-"));
  queuePath = join(tempDir, ".orch", "queue.json");
  registryPath = join(tempDir, ".orch", "runs.json");
  await mkdir(join(tempDir, ".orch"), { recursive: true });

  process.chdir(tempDir);
  process.argv = ["node", "/virtual/main.ts"];

  mocks.defaultQueuePath.mockReturnValue(queuePath);
  mocks.renderDashboard.mockResolvedValue(undefined);
  mocks.aggregateDashboard.mockResolvedValue({
    active: [],
    queued: [],
    completed: [],
  });
  mocks.addToQueue.mockResolvedValue(undefined);
  mocks.readQueue.mockResolvedValue([]);
  mocks.removeFromQueue.mockResolvedValue(undefined);
  mocks.assertGitRepo.mockResolvedValue(undefined);
  mocks.buildOrchrSummary.mockReturnValue(undefined);
  mocks.auditContextInBackground.mockResolvedValue(undefined);
  mocks.runFingerprint.mockResolvedValue({
    brief: "brief",
    context: {
      effective: {
        context: { architecture: "Clean Architecture" },
      },
    },
  });
  mocks.parseProviderFlag.mockReturnValue("claude");
  mocks.parseExecutionPreference.mockReturnValue("auto");
  mocks.parseTreeFlag.mockReturnValue(undefined);
  mocks.loadAndResolveOrchrConfig.mockReturnValue({
    skills: {
      tdd: { default: true },
      review: { default: true },
      verify: { default: true },
      plan: { default: true },
      gap: { default: true },
    },
    rules: {},
    config: {},
    worktreeSetup: [],
    agents: undefined,
  });
  mocks.loadTieredSkills.mockReturnValue({
    tdd: "tdd-skill",
    review: "review-skill",
    verify: "verify-skill",
    plan: "plan-skill",
    gap: "gap-skill",
    completeness: "completeness-skill",
  });
  mocks.buildSkillOverrides.mockReturnValue({});
  mocks.resolveAllAgentConfigs.mockReturnValue(AGENT_DEFAULTS);
  mocks.createHud.mockReturnValue(makeHud());
  mocks.doGeneratePlan.mockResolvedValue(join(tempDir, ".orch", "plan-generated.json"));
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.argv = [...originalArgv];
  await rm(tempDir, { recursive: true, force: true });
});

describe("main subcommands", () => {
  it("routes dash through renderDashboard without starting orchestration", async () => {
    process.argv = ["node", "/virtual/main.ts", "dash"];

    await expect(invokeMain()).resolves.toBeUndefined();

    expect(mocks.renderDashboard).toHaveBeenCalledWith({
      registryPath,
      queuePath,
      launchCommand: process.execPath,
      launchArgs: ["/virtual/main.ts"],
    });
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
    expect(mocks.executeGroups).not.toHaveBeenCalled();
    expect(mocks.agentSpawnerFactorySpy).not.toHaveBeenCalled();
  });

  it("routes status through aggregateDashboard without starting orchestration", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = { id: "run-123", status: "active" };
    mocks.aggregateDashboard.mockResolvedValue({
      active: [run],
      queued: [],
      completed: [],
    });
    process.argv = ["node", "/virtual/main.ts", "status", "run-123"];

    await expect(invokeMain()).resolves.toBeUndefined();

    expect(mocks.aggregateDashboard).toHaveBeenCalledWith(registryPath, queuePath);
    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(run, null, 2));
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
    expect(mocks.executeGroups).not.toHaveBeenCalled();
  });

  it("routes queue add through addToQueue without starting orchestration", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.parseExecutionPreference.mockReturnValue("auto");
    const planPath = "./queued-plan.json";
    const resolvedPlanPath = resolve(planPath);
    const currentCwd = process.cwd();
    process.argv = ["node", "/virtual/main.ts", "queue", "add", planPath, "--branch", "feat/queued"];

    await expect(invokeMain()).resolves.toBeUndefined();

    expect(mocks.addToQueue).toHaveBeenCalledTimes(1);
    expect(mocks.addToQueue).toHaveBeenCalledWith(
      queuePath,
      expect.objectContaining({
        repo: currentCwd,
        planPath: resolvedPlanPath,
        branch: "feat/queued",
        flags: ["--branch", "feat/queued"],
        addedAt: expect.any(String),
        id: expect.any(String),
      }),
    );
    expect(consoleLog).toHaveBeenCalledWith(`Queued ${resolvedPlanPath}`);
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
    expect(mocks.executeGroups).not.toHaveBeenCalled();
  });

  it("routes queue list through readQueue without starting orchestration", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const queued = [{ id: "queue-1", planPath: "/tmp/plan.json" }];
    mocks.readQueue.mockResolvedValue(queued);
    process.argv = ["node", "/virtual/main.ts", "queue", "list"];

    await expect(invokeMain()).resolves.toBeUndefined();

    expect(mocks.readQueue).toHaveBeenCalledWith(queuePath);
    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(queued, null, 2));
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
    expect(mocks.executeGroups).not.toHaveBeenCalled();
  });

  it("routes queue remove through removeFromQueue without starting orchestration", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/virtual/main.ts", "queue", "remove", "queue-42"];

    await expect(invokeMain()).resolves.toBeUndefined();

    expect(mocks.removeFromQueue).toHaveBeenCalledWith(queuePath, "queue-42");
    expect(consoleLog).toHaveBeenCalledWith("Removed queue-42");
    expect(mocks.assertGitRepo).not.toHaveBeenCalled();
    expect(mocks.executeGroups).not.toHaveBeenCalled();
  });

  it("routes plan through doGeneratePlan without starting execution", async () => {
    const inventoryPath = join(tempDir, "inventory.md");
    const currentCwd = process.cwd();
    await writeFile(inventoryPath, "# inventory");
    const hud = makeHud();
    mocks.createHud.mockReturnValue(hud);
    mocks.parseExecutionPreference.mockReturnValue("grouped");
    process.argv = ["node", "/virtual/main.ts", "plan", inventoryPath, "--grouped", "--no-interaction"];

    await expect(invokeMain()).resolves.toBeUndefined();

    expect(mocks.assertGitRepo).toHaveBeenCalledWith(currentCwd);
    expect(mocks.doGeneratePlan).toHaveBeenCalledTimes(1);
    const [
      passedInventoryPath,
      passedBrief,
      passedOutputDir,
      passedLog,
      passedSpawnPlanAgent,
      passedExecutionMode,
      passedRepoContext,
    ] = mocks.doGeneratePlan.mock.calls[0]!;
    expect(passedInventoryPath).toBe(inventoryPath);
    expect(passedBrief).toBe("brief");
    expect(passedOutputDir).toBe(join(currentCwd, ".orch"));
    expect(passedLog).toBe(console.log);
    expect(passedSpawnPlanAgent).toEqual(expect.any(Function));
    expect(passedExecutionMode).toBe("grouped");
    expect(passedRepoContext).toEqual({ architecture: "Clean Architecture" });
    expect(mocks.agentSpawnerFactorySpy).toHaveBeenCalledTimes(1);
    expect(mocks.executeGroups).not.toHaveBeenCalled();
    expect(hud.teardown).toHaveBeenCalledTimes(1);
  });
});
