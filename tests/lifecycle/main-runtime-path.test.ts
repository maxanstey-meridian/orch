import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentSpawnerFactorySpy: vi.fn(),
  auditContextInBackground: vi.fn(),
  assertGitRepo: vi.fn(),
  buildOrchrSummary: vi.fn(),
  buildSkillOverrides: vi.fn(),
  checkWorktreeResume: vi.fn(),
  createHud: vi.fn(),
  loadAndResolveOrchrConfig: vi.fn(),
  loadTieredSkills: vi.fn(),
  parseBranchFlag: vi.fn(),
  parseExecutionPreference: vi.fn(),
  parsePlan: vi.fn(),
  parseProviderFlag: vi.fn(),
  parseTreeFlag: vi.fn(),
  resolveAllAgentConfigs: vi.fn(),
  resolveWorktree: vi.fn(),
  runFingerprint: vi.fn(),
}));

vi.mock("#domain/agent-config.js", () => ({
  resolveAllAgentConfigs: mocks.resolveAllAgentConfigs,
}));

vi.mock("#infrastructure/cli/cli-args.js", () => ({
  parseBranchFlag: mocks.parseBranchFlag,
  parseExecutionPreference: mocks.parseExecutionPreference,
  parseProviderFlag: mocks.parseProviderFlag,
  parseTreeFlag: mocks.parseTreeFlag,
}));

vi.mock("#infrastructure/config/orchrc.js", () => ({
  buildOrchrSummary: mocks.buildOrchrSummary,
  loadAndResolveOrchrConfig: mocks.loadAndResolveOrchrConfig,
}));

vi.mock("#infrastructure/context/context-auditor.js", () => ({
  auditContextInBackground: mocks.auditContextInBackground,
}));

vi.mock("#infrastructure/fingerprint.js", () => ({
  runFingerprint: mocks.runFingerprint,
}));

vi.mock("#infrastructure/git/repo-check.js", () => ({
  assertGitRepo: mocks.assertGitRepo,
}));

vi.mock("#infrastructure/git/worktree-setup.js", () => ({
  resolveWorktree: mocks.resolveWorktree,
}));

vi.mock("#infrastructure/git/worktree.js", () => ({
  checkWorktreeResume: mocks.checkWorktreeResume,
}));

vi.mock("#infrastructure/plan/plan-parser.js", () => ({
  parsePlan: mocks.parsePlan,
}));

vi.mock("#infrastructure/skill-loader.js", () => ({
  buildSkillOverrides: mocks.buildSkillOverrides,
  loadTieredSkills: mocks.loadTieredSkills,
}));

vi.mock("#ui/hud.js", () => ({
  createHud: mocks.createHud,
}));

vi.mock("#infrastructure/factories.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#infrastructure/factories.js")>();
  mocks.agentSpawnerFactorySpy.mockImplementation(actual.agentSpawnerFactory);
  return {
    ...actual,
    agentSpawnerFactory: mocks.agentSpawnerFactorySpy,
  };
});

const originalArgv = [...process.argv];
const originalCwd = process.cwd();

let tempDir: string;
let planPath: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  tempDir = await mkdtemp(join(tmpdir(), "orch-main-runtime-"));
  const orchDir = join(tempDir, ".orch");
  planPath = join(orchDir, "plan-abc123.json");
  await mkdir(orchDir, { recursive: true });

  await writeFile(
    planPath,
    JSON.stringify({
      groups: [
        {
          name: "Runtime path",
          slices: [
            {
              number: 1,
              title: "Slice",
              why: "exercise real main/composition wiring",
              files: [],
              details: "details",
              tests: "tests",
            },
          ],
        },
      ],
    }),
  );

  process.chdir(tempDir);
  process.argv = ["node", "/virtual/main.ts", "--work", planPath, "--skip-fingerprint", "--no-interaction"];

  mocks.assertGitRepo.mockResolvedValue(undefined);
  mocks.buildOrchrSummary.mockReturnValue(undefined);
  mocks.auditContextInBackground.mockResolvedValue(undefined);
  mocks.runFingerprint.mockResolvedValue({
    brief: "brief",
    context: {
      version: 1,
      repo: {
        rootPath: tempDir,
        repoName: "orch-main-runtime",
        generatedAt: "2026-04-10T00:00:00.000Z",
      },
      layers: {
        operator: { context: {}, provenance: {} },
        detected: {
          context: { architecture: "Clean Architecture" },
          provenance: {
            "context.architecture": {
              source: "detected",
              updatedAt: "2026-04-10T00:00:00.000Z",
              supportingFiles: ["package.json"],
            },
          },
        },
        planner: { context: {}, provenance: {} },
      },
      effective: {
        context: { architecture: "Clean Architecture" },
        provenance: {
          "context.architecture": {
            source: "detected",
            updatedAt: "2026-04-10T00:00:00.000Z",
            supportingFiles: ["package.json"],
          },
        },
      },
    },
  });
  mocks.parseProviderFlag.mockReturnValue("claude");
  mocks.parseExecutionPreference.mockReturnValue("auto");
  mocks.parseTreeFlag.mockReturnValue(undefined);
  mocks.parseBranchFlag.mockReturnValue(undefined);
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
  mocks.resolveAllAgentConfigs.mockReturnValue({});
  mocks.parsePlan.mockResolvedValue([
    {
      name: "Runtime path",
      slices: [
        {
          number: 1,
          title: "Slice",
          content: "content",
        },
      ],
    },
  ]);
  mocks.checkWorktreeResume.mockResolvedValue({ ok: true });
  mocks.resolveWorktree.mockResolvedValue({
    cwd: tempDir,
    skipStash: true,
    updatedState: {},
    worktreeInfo: undefined,
  });
  mocks.createHud.mockReturnValue({
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
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.argv = [...originalArgv];
  await rm(tempDir, { recursive: true, force: true });
});

describe("main runtime path", () => {
  it("reaches the real composition root and invokes agentSpawnerFactory", async () => {
    const { main } = await import("../../src/main.js");

    await expect(
      main({
        onSignal: () => process,
        exit: vi.fn(),
        registryPath: join(tempDir, ".orch", "runs.json"),
      }),
    ).rejects.toThrow("createContainer runtime wiring has not been restored yet");

    expect(mocks.agentSpawnerFactorySpy).toHaveBeenCalledTimes(1);
  });

  it("does not await the auditor before continuing foreground startup", async () => {
    mocks.auditContextInBackground.mockReturnValue(new Promise(() => {}));
    const { main } = await import("../../src/main.js");
    const currentCwd = process.cwd();

    await expect(
      main({
        onSignal: () => process,
        exit: vi.fn(),
        registryPath: join(tempDir, ".orch", "runs.json"),
      }),
    ).rejects.toThrow("createContainer runtime wiring has not been restored yet");

    expect(mocks.auditContextInBackground).toHaveBeenCalledWith(
      join(currentCwd, ".orch"),
      currentCwd,
    );
    expect(mocks.agentSpawnerFactorySpy).toHaveBeenCalledTimes(1);
  });

  it("catches and ignores auditor rejections", async () => {
    mocks.auditContextInBackground.mockRejectedValue(new Error("audit failed"));
    const { main } = await import("../../src/main.js");
    const currentCwd = process.cwd();

    await expect(
      main({
        onSignal: () => process,
        exit: vi.fn(),
        registryPath: join(tempDir, ".orch", "runs.json"),
      }),
    ).rejects.toThrow("createContainer runtime wiring has not been restored yet");

    expect(mocks.auditContextInBackground).toHaveBeenCalledWith(
      join(currentCwd, ".orch"),
      currentCwd,
    );
    expect(mocks.agentSpawnerFactorySpy).toHaveBeenCalledTimes(1);
  });
});
