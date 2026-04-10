import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveAllAgentConfigs } from "#domain/agent-config.js";
import type { ExecutionMode, ExecutionPreference, OrchestratorConfig } from "#domain/config.js";
import { hasRepoContextArtifact } from "#domain/context.js";
import { CreditExhaustedError, IncompleteRunError } from "#domain/errors.js";
import type { Group, PlanDocument } from "#domain/plan.js";
import {
  parseBranchFlag,
  parseExecutionPreference,
  parseProviderFlag,
  parseTreeFlag,
} from "#infrastructure/cli/cli-args.js";
import { buildOrchrSummary, loadAndResolveOrchrConfig } from "#infrastructure/config/orchrc.js";
import { auditContextInBackground } from "#infrastructure/context/context-auditor.js";
import { runFingerprint } from "#infrastructure/fingerprint.js";
import { assertGitRepo } from "#infrastructure/git/repo-check.js";
import { resolveWorktree } from "#infrastructure/git/worktree-setup.js";
import { checkWorktreeResume } from "#infrastructure/git/worktree.js";
import {
  ensureCanonicalPlan,
  generatePlanId,
  isPlanFormat,
  planFileName,
} from "#infrastructure/plan/plan-generator.js";
import { parsePlan } from "#infrastructure/plan/plan-parser.js";
import { defaultRegistryPath, registerRun, withRegistryLock } from "#infrastructure/registry/run-registry.js";
import { loadState, statePathForPlan } from "#infrastructure/state/state.js";
import { buildSkillOverrides, loadTieredSkills } from "#infrastructure/skill-loader.js";
import { formatPlanSummary, printStartupBanner } from "#ui/display.js";
import { createHud } from "#ui/hud.js";
import { createContainer } from "./composition-root.js";

export { withRegistryLock } from "#infrastructure/registry/run-registry.js";

type MainRuntime = {
  readonly registryPath?: string;
  readonly onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => NodeJS.Process;
  readonly exit?: (code: number) => void;
};

const getArgValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
};

const executionModeFromPreference = (
  preference: ExecutionPreference,
  workMode: boolean,
): ExecutionMode => {
  if (!workMode && preference === "quick") {
    return "direct";
  }
  switch (preference) {
    case "grouped":
      return "grouped";
    case "auto":
    case "long":
    case "quick":
      return "sliced";
  }
};

const writeDirectPlan = (inventoryPath: string, orchDir: string, planId: string): string => {
  mkdirSync(orchDir, { recursive: true });
  const planPath = resolve(orchDir, planFileName(planId));
  const inventoryContent = readFileSync(inventoryPath, "utf-8");
  const document: PlanDocument = {
    groups: [
      {
        name: "Direct",
        slices: [
          {
            number: 1,
            title: "Direct request",
            content: inventoryContent,
            why: "Direct request execution.",
            files: [],
            details: inventoryContent,
            tests: "Run the relevant verification for the direct request.",
          },
        ],
      },
    ],
  };
  writeFileSync(planPath, JSON.stringify(document, null, 2));
  return planPath;
};

const registerActiveRun = async (
  registryPath: string,
  entry: {
    readonly id: string;
    readonly pid: number;
    readonly repo: string;
    readonly planPath: string;
    readonly statePath: string;
    readonly branch?: string;
    readonly startedAt: string;
  },
): Promise<void> => {
  await withRegistryLock(registryPath, async () => {
    await registerRun(registryPath, entry);
  });
};

const scheduleContextAudit = (outputDir: string, cwd: string): void => {
  try {
    const auditPromise = auditContextInBackground(outputDir, cwd);
    void auditPromise.catch(() => {});
  } catch {
    // Background verification must never abort foreground startup or planning.
  }
};

export const main = async (runtime: MainRuntime = {}): Promise<void> => {
  const args = process.argv.slice(2);
  const exit = runtime.exit ?? ((code: number) => process.exit(code));
  const onSignal = runtime.onSignal ?? ((signal, handler) => process.on(signal, handler));
  const registryPath = runtime.registryPath ?? defaultRegistryPath();

  await assertGitRepo(process.cwd());

  const inventoryPath = getArgValue(args, "--plan");
  const workPath = getArgValue(args, "--work");
  const workMode = workPath !== undefined;
  const showPlan = args.includes("--show-plan");
  const auto = args.includes("--auto") || args.includes("--no-interaction");
  const treePath = parseTreeFlag(args);
  const provider = parseProviderFlag(args);
  const executionPreference = parseExecutionPreference(args);
  const cwd = process.cwd();
  const orchDir = resolve(cwd, ".orch");

  const orchrc = loadAndResolveOrchrConfig(cwd);
  const orchrcSummary = buildOrchrSummary(orchrc);
  const { brief, context } = await runFingerprint({
    cwd,
    outputDir: orchDir,
    skip: args.includes("--skip-fingerprint"),
    forceRefresh: !args.includes("--skip-fingerprint"),
  });
  scheduleContextAudit(orchDir, cwd);

  const executionMode = executionModeFromPreference(executionPreference, workMode);
  const tier = "medium" as const;

  let planPath: string;
  let activePlanId: string;

  if (workMode) {
    planPath = resolve(workPath);
    activePlanId = ensureCanonicalPlan(planPath, orchDir);
  } else if (inventoryPath !== undefined) {
    const resolvedInventoryPath = resolve(inventoryPath);
    const content = readFileSync(resolvedInventoryPath, "utf-8");
    if (isPlanFormat(content)) {
      planPath = resolvedInventoryPath;
      activePlanId = ensureCanonicalPlan(planPath, orchDir);
    } else if (executionMode === "direct") {
      activePlanId = generatePlanId();
      planPath = writeDirectPlan(resolvedInventoryPath, orchDir, activePlanId);
    } else {
      throw new Error("Inventory-to-plan generation is not available in the restored runtime path");
    }
  } else {
    throw new Error("Provide --plan <inventory> or --work <plan>");
  }

  const statePath = statePathForPlan(orchDir, activePlanId);
  const branch = parseBranchFlag(args, activePlanId);

  const groups = await parsePlan(planPath);
  if (showPlan) {
    formatPlanSummary(console.log, groups);
    exit(0);
    return;
  }

  const state = await loadState(statePath);
  const resumeCheck = await checkWorktreeResume(branch, treePath, state);
  if (!resumeCheck.ok) {
    exit(1);
    return;
  }

  const { cwd: effectiveCwd, worktreeInfo } = await resolveWorktree({
    branchName: branch,
    cwd,
    treePath,
    worktreeSetup: orchrc.worktreeSetup,
    activePlanId,
    state,
    stateFile: statePath,
    log: console.log,
  });

  await registerActiveRun(registryPath, {
    id: randomUUID(),
    pid: process.pid,
    repo: process.cwd(),
    planPath,
    statePath,
    branch,
    startedAt: new Date().toISOString(),
  });

  const isInteractive = !auto && process.stdout.isTTY === true && process.stdin.isTTY === true;
  const hud = createHud(isInteractive);
  const skills = loadTieredSkills(tier, orchrc);
  const planContent = await readFile(planPath, "utf-8");
  const config: OrchestratorConfig = {
    cwd: effectiveCwd,
    planPath,
    planContent,
    brief,
    executionMode,
    executionPreference,
    auto,
    reviewThreshold: orchrc.config.reviewThreshold ?? 30,
    maxReviewCycles: orchrc.config.maxReviewCycles ?? 3,
    stateFile: statePath,
    logPath: null,
    tier,
    skills,
    skillOverrides: buildSkillOverrides(orchrc),
    maxReplans: orchrc.config.maxReplans ?? 2,
    defaultProvider: provider,
    agentConfig: resolveAllAgentConfigs(orchrc.agents, provider),
    tddRules: orchrc.rules.tdd,
    reviewRules: orchrc.rules.review,
  };

  let disposed = false;
  let cleanup: () => void = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    hud.teardown();
  };

  onSignal("SIGINT", () => {
    cleanup();
    exit(130);
  });
  onSignal("SIGTERM", () => {
    cleanup();
    exit(143);
  });

  const container = createContainer(config, hud);
  const orch = container.resolve("runOrchestration");
  cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    orch.dispose();
  };

  try {
    await orch.execute(groups, {
      onReady: (info: { readonly tddSessionId: string; readonly reviewSessionId: string }) => {
        printStartupBanner(console.log, {
          planPath,
          brief,
          hasContext: hasRepoContextArtifact(context),
          executionMode,
          auto,
          interactive: isInteractive,
          tddSessionId: info.tddSessionId,
          reviewSessionId: info.reviewSessionId,
          groups: groups as readonly Group[],
          worktree: worktreeInfo,
          orchrcSummary,
        });
      },
    });
  } catch (error) {
    cleanup();
    if (error instanceof CreditExhaustedError) {
      exit(2);
      return;
    }
    if (error instanceof IncompleteRunError) {
      exit(1);
      return;
    }
    throw error;
  }

  cleanup();
};

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).replace(/\.ts$/u, "") ===
    new URL(import.meta.url).pathname.replace(/\.ts$/u, "");

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
