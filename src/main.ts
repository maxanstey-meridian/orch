#!/usr/bin/env npx ts-node
/**
 * main.ts — TDD orchestrator CLI
 *
 * Wires tested leaf modules into a procedural pipeline.
 * No dep injection, no framework — reads top-to-bottom.
 *
 * Usage:
 *   npx ts-node src/main.ts --plan inventory.md               # bootstrap from inventory
 *   npx ts-node src/main.ts --work plan.md                    # execute a plan
 *   npx ts-node src/main.ts --work plan.md --group Auth       # start from group
 *   npx ts-node src/main.ts --work plan.md --auto             # auto-accept all prompts (--no-interaction is an alias)
 *   npx ts-node src/main.ts --work plan.json --show-plan      # inspect plan structure
 *   npx ts-node src/main.ts --work plan.md --reset            # clear state and re-run
 *   npx ts-node src/main.ts --init --plan inventory.md        # interactive project init
 */

import { randomUUID } from "crypto";
import { readFileSync, mkdirSync, watch, writeFileSync, existsSync } from "fs";
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { resolveAllAgentConfigs } from "#domain/agent-config.js";
import type { ExecutionMode, ExecutionPreference, OrchestratorConfig } from "#domain/config.js";
import type { DashboardModel, DashboardRun } from "#domain/dashboard.js";
import { CreditExhaustedError, IncompleteRunError } from "#domain/errors.js";
import type { Group } from "#domain/plan.js";
import type { QueueEntry } from "#domain/queue.js";
import {
  parseBranchFlag,
  parseExecutionPreference,
  parseProviderFlag,
} from "#infrastructure/cli/cli-args.js";
import { parseSubcommand } from "#infrastructure/cli/subcommands.js";
import {
  loadAndResolveOrchrConfig,
  resolveSkillValue,
  buildOrchrSummary,
} from "#infrastructure/config/orchrc.js";
import { aggregateDashboard } from "#infrastructure/dashboard/data-aggregator.js";
import {
  planGeneratorSpawnerFactory,
  requestTriageSpawnerFactory,
} from "#infrastructure/factories.js";
import { runFingerprint } from "#infrastructure/fingerprint.js";
import { getStatus, stashBackup } from "#infrastructure/git/git.js";
import { assertGitRepo } from "#infrastructure/git/repo-check.js";
import { resolveWorktree } from "#infrastructure/git/worktree-setup.js";
import { checkWorktreeResume, runCleanup } from "#infrastructure/git/worktree.js";
import { logPathForPlan } from "#infrastructure/log/log-writer.js";
import {
  isPlanFormat,
  ensureCanonicalPlan,
  doGeneratePlan,
  resolvePlanId,
} from "#infrastructure/plan/plan-generator.js";
import { parsePlan } from "#infrastructure/plan/plan-parser.js";
import {
  buildRequestTriagePrompt,
  parseRequestTriageResult,
} from "#infrastructure/request-triage.js";
import {
  defaultQueuePath,
  addToQueue,
  readQueue,
  removeFromQueue,
} from "#infrastructure/queue/queue-store.js";
import {
  defaultRegistryPath,
  registerRun,
} from "#infrastructure/registry/run-registry.js";
import {
  loadState,
  saveState,
  clearState,
  statePathForPlan,
  type OrchestratorState,
} from "#infrastructure/state/state.js";
import { renderDashboard } from "#ui/dashboard/dashboard-app.js";
import {
  a,
  ts,
  logSection,
  printStartupBanner,
  formatPlanSummary,
  printExecutionModeBanner,
} from "#ui/display.js";
import { createHud } from "#ui/hud.js";
import { runInit, profileToMarkdown } from "#ui/init.js";
import { createContainer } from "./composition-root.js";

let log: (...args: unknown[]) => void = (...args: unknown[]) => console.log(...args);

type MainRuntime = {
  registryPath?: string;
  queuePath?: string;
  argv?: string[];
  dashboardLaunch?: {
    readonly launchCommand: string;
    readonly launchArgs: readonly string[];
  };
  onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => NodeJS.Process;
  exit?: (code: number) => void;
};

type RegistryLockOwner = {
  readonly pid: number;
  readonly acquiredAt: string;
};

const hasCode = (value: unknown): value is { readonly code: string } =>
  typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";

const delay = async (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const LOCK_OWNER_FILE = "owner.json";
const dashboardBuiltEntryPath = resolve(import.meta.dirname, "..", "dist", "src", "main.js");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const resolveDashboardLaunch = (
  argv: readonly string[],
  runtimeLaunch?: {
    readonly launchCommand: string;
    readonly launchArgs: readonly string[];
  },
): { readonly launchCommand: string; readonly launchArgs: readonly string[] } => {
  if (runtimeLaunch !== undefined) {
    return runtimeLaunch;
  }

  const currentEntry = argv[1];
  if (typeof currentEntry === "string" && currentEntry.length > 0) {
    return {
      launchCommand: process.execPath,
      launchArgs: [...process.execArgv, resolve(currentEntry)],
    };
  }

  if (existsSync(dashboardBuiltEntryPath)) {
    return {
      launchCommand: process.execPath,
      launchArgs: [...process.execArgv, dashboardBuiltEntryPath],
    };
  }

  throw new Error("Cannot resolve a runnable orch entrypoint for dashboard queue execution.");
};

const isRegistryLockOwner = (value: unknown): value is RegistryLockOwner =>
  isRecord(value) &&
  typeof value.pid === "number" &&
  Number.isInteger(value.pid) &&
  value.pid > 0 &&
  typeof value.acquiredAt === "string";

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readRegistryLockOwner = async (lockPath: string): Promise<RegistryLockOwner | undefined> => {
  try {
    const raw = await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRegistryLockOwner(parsed) ? parsed : undefined;
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return undefined;
    }

    return undefined;
  }
};

const removeStaleRegistryLock = async (lockPath: string): Promise<boolean> => {
  const owner = await readRegistryLockOwner(lockPath);
  if (owner && !isProcessAlive(owner.pid)) {
    await rm(lockPath, { force: true, recursive: true });
    return true;
  }

  if (owner) {
    return false;
  }

  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;
    if (ageMs < 60_000) {
      return false;
    }

    await rm(lockPath, { force: true, recursive: true });
    return true;
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }
};

export const withRegistryLock = async <T>(
  registryPath: string,
  work: () => Promise<T>,
): Promise<T> => {
  const lockPath = `${registryPath}.lock`;
  await mkdir(dirname(registryPath), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, LOCK_OWNER_FILE),
        JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
      );
      break;
    } catch (error) {
      if (hasCode(error) && error.code === "EEXIST") {
        if (await removeStaleRegistryLock(lockPath)) {
          continue;
        }

        await delay(5);
        continue;
      }

      throw error;
    }
  }

  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
};

const printLines = (lines: readonly string[]): void => {
  for (const line of lines) {
    console.log(line);
  }
};

const formatStatusTable = (title: string, rows: readonly string[]): string[] => {
  if (rows.length === 0) {
    return [title, "  (none)"];
  }

  return [title, ...rows.map((row) => `  ${row}`)];
};

const formatRunSummaryRow = (run: DashboardRun): string =>
  `${run.id} ${run.repo} ${run.status} ${run.sliceProgress} ${run.currentPhase ?? "-"} ${run.elapsed}`;

const formatQueueSummaryRow = (entry: QueueEntry): string =>
  `${entry.id} ${entry.repo} ${entry.planPath} ${entry.flags.join(" ") || "-"}`;

const formatDashboardSummary = (model: DashboardModel): string[] => [
  ...formatStatusTable("Active", model.active.map(formatRunSummaryRow)),
  ...formatStatusTable("Queued", model.queued.map(formatQueueSummaryRow)),
  ...formatStatusTable("Completed", model.completed.map(formatRunSummaryRow)),
];

const formatDetailLines = (run: DashboardRun): string[] => {
  const lines = [
    `Run ${run.id}`,
    `Repo: ${run.repo}`,
    `Status: ${run.status}`,
    `Plan: ${run.planName ?? "-"}`,
    `Branch: ${run.branch ?? "-"}`,
    `Progress: ${run.sliceProgress}`,
    `Phase: ${run.currentPhase ?? "-"}`,
    `Elapsed: ${run.elapsed}`,
    `Log: ${run.logPath ?? "-"}`,
  ];

  if (run.groups === undefined || run.groups.length === 0) {
    return lines;
  }

  return [
    ...lines,
    ...run.groups.flatMap((group) => [
      group.name,
      ...group.slices.map(
        (slice) =>
          `  ${slice.status} S${slice.number} ${slice.title}${slice.elapsed ? ` ${slice.elapsed}` : ""}`,
      ),
    ]),
  ];
};

const formatQueuedDetail = (entry: QueueEntry): string[] => [
  `Queued ${entry.id}`,
  `Repo: ${entry.repo}`,
  `Plan: ${entry.planPath}`,
  `Branch: ${entry.branch ?? "-"}`,
  `Flags: ${entry.flags.join(" ") || "-"}`,
  `Added: ${entry.addedAt}`,
];

const resolveExecutionMode = (executionPreference: ExecutionPreference): ExecutionMode => {
  switch (executionPreference) {
    case "quick":
      return "direct";
    case "grouped":
      return "grouped";
    case "long":
    case "auto":
      return "sliced";
  }
};

const readPlanExecutionMode = (planContent: string): ExecutionMode | undefined => {
  try {
    const parsed: unknown = JSON.parse(planContent);
    if (!isRecord(parsed) || parsed.executionMode === undefined) {
      return undefined;
    }

    const executionMode = parsed.executionMode;
    if (executionMode === "grouped" || executionMode === "sliced") {
      return executionMode;
    }

    switch (executionMode) {
      case "direct":
        throw new Error("Plan metadata executionMode=direct is invalid for --work.");
      default:
        throw new Error(
          `Invalid plan executionMode metadata: ${String(executionMode)}.`,
        );
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }

    throw error;
  }
};

const buildDirectExecutionGroups = (requestContent: string, inventoryPath: string): readonly Group[] => [
  {
    name: "Direct",
    slices: [
      {
        number: 1,
        title: "Direct request",
        content: requestContent,
        why: "Direct execution was selected during bootstrap.",
        files: [{ path: inventoryPath, action: "edit" }],
        details: "Implement the inventory request directly without generated plan slices.",
        tests: "Run the relevant tests and explain the coverage changes.",
      },
    ],
  },
];

const resolvePlannedWorkExecutionMode = (
  planContent: string,
  executionPreference: ExecutionPreference,
): ExecutionMode => {
  if (executionPreference !== "auto") {
    throw new Error(
      "Execution mode overrides are not supported with --work until plan metadata is available.",
    );
  }

  return readPlanExecutionMode(planContent) ?? "sliced";
};

const resolveInventoryExecutionMode = async (opts: {
  executionPreference: ExecutionPreference;
  requestContent: string;
  agentConfig: ReturnType<typeof resolveAllAgentConfigs>;
  cwd: string;
}): Promise<ExecutionMode> => {
  if (opts.executionPreference !== "auto") {
    return resolveExecutionMode(opts.executionPreference);
  }

  const triageAgent = requestTriageSpawnerFactory({
    agentConfig: opts.agentConfig,
    cwd: opts.cwd,
  })();

  try {
    const prompt = buildRequestTriagePrompt(opts.requestContent);
    const result = await triageAgent.send(prompt);
    const triage = parseRequestTriageResult(result.assistantText ?? result.resultText ?? "");
    return triage.mode;
  } finally {
    triageAgent.kill();
  }
};

const findDashboardEntry = (
  model: DashboardModel,
  id: string,
):
  | { readonly kind: "run"; readonly run: DashboardRun }
  | { readonly kind: "queue"; readonly entry: QueueEntry }
  | undefined => {
  const run = [...model.active, ...model.completed].find((candidate) => candidate.id === id);
  if (run !== undefined) {
    return { kind: "run", run };
  }

  const entry = model.queued.find((candidate) => candidate.id === id);
  if (entry !== undefined) {
    return { kind: "queue", entry };
  }

  return undefined;
};

const followLogFile = async (logPath: string): Promise<never> => {
  let offset = 0;

  const flush = async (): Promise<void> => {
    let content: Buffer;
    try {
      content = await readFile(logPath);
    } catch (error) {
      if (hasCode(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    if (content.length <= offset) {
      return;
    }

    process.stdout.write(content.subarray(offset).toString("utf8"));
    offset = content.length;
  };

  await flush();

  return new Promise<never>((_resolve, reject) => {
    const fileName = basename(logPath);
    const watcher = watch(dirname(logPath), async (_eventType, changedFileName) => {
      if (changedFileName !== null && changedFileName !== fileName) {
        return;
      }

      try {
        await flush();
      } catch (error) {
        watcher.close();
        reject(error);
      }
    });

    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
  });
};

// ─── Main ────────────────────────────────────────────────────────────────────

export const main = async (runtime: MainRuntime = {}) => {
  const onSignal =
    runtime.onSignal ??
    ((signal: "SIGINT" | "SIGTERM", handler: () => void) => process.on(signal, handler));
  const exit = runtime.exit ?? process.exit;
  const argv = runtime.argv ?? process.argv;
  const queuePath = runtime.queuePath ?? defaultQueuePath();
  const registryPath = runtime.registryPath ?? defaultRegistryPath();
  const subcommand = parseSubcommand(argv);
  const cwd = process.cwd();
  let args: string[];

  const exitWithError = (message: string): void => {
    console.error(message);
    exit(1);
  };

  if (subcommand.command === "dash") {
    const dashboardLaunch = resolveDashboardLaunch(argv, runtime.dashboardLaunch);
    await renderDashboard({
      registryPath,
      queuePath,
      launchCommand: dashboardLaunch.launchCommand,
      launchArgs: dashboardLaunch.launchArgs,
    });
    return;
  }

  if (subcommand.command === "queue") {
    if ("error" in subcommand) {
      switch (subcommand.error) {
        case "missing-action":
          exitWithError("queue requires an action: add, list, or remove.");
          return;
        case "unknown-action":
          exitWithError(`Unsupported queue action: ${subcommand.action}`);
          return;
        case "missing-plan-path":
          exitWithError("queue add requires a plan path.");
          return;
        case "missing-id":
          exitWithError("queue remove requires an id.");
          return;
      }
    }

    if (subcommand.action === "add") {
      const planPath = resolve(subcommand.planPath);
      const planId = resolvePlanId(planPath);
      const branch = parseBranchFlag(subcommand.flags, planId);
      const entry = {
        id: planId,
        repo: cwd,
        planPath,
        ...(branch === undefined ? {} : { branch }),
        flags: subcommand.flags,
        addedAt: new Date().toISOString(),
      } satisfies QueueEntry;

      await addToQueue(queuePath, entry);
      console.log(`Queued ${entry.id} ${entry.planPath}`);
      return;
    }

    if (subcommand.action === "list") {
      printLines(
        formatStatusTable("Queue", (await readQueue(queuePath)).map(formatQueueSummaryRow)),
      );
      return;
    }

    await removeFromQueue(queuePath, subcommand.id);
    console.log(`Removed ${subcommand.id}`);
    return;
  }

  if (subcommand.command === "status") {
    const model = await aggregateDashboard(registryPath, queuePath);
    if (subcommand.id === undefined) {
      printLines(formatDashboardSummary(model));
      return;
    }

    const entry = findDashboardEntry(model, subcommand.id);
    if (entry === undefined) {
      exitWithError(`No dashboard entry found for id ${subcommand.id}.`);
      return;
    }

    if (subcommand.follow) {
      if (entry.kind !== "run" || entry.run.logPath === undefined) {
        exitWithError(`Cannot follow logs for ${subcommand.id}.`);
        return;
      }

      await followLogFile(entry.run.logPath);
      return;
    }

    printLines(
      entry.kind === "run" ? formatDetailLines(entry.run) : formatQueuedDetail(entry.entry),
    );
    return;
  }

  if (subcommand.command === "work") {
    if ("error" in subcommand) {
      exitWithError("--work requires a plan path. Usage: --work <plan.md>");
      return;
    }

    args = ["--work", subcommand.planPath, ...subcommand.flags];
  } else if (subcommand.command === "plan") {
    if ("error" in subcommand) {
      exitWithError("--plan requires an inventory path.");
      return;
    }

    args = ["--plan", subcommand.inventoryPath, ...subcommand.flags];
  } else {
    args = subcommand.args;
  }

  const getArg = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const inventoryPath = getArg("--plan");
  if (args.includes("--resume")) {
    exitWithError("--resume is no longer supported. Use --work <plan> instead.");
    return;
  }
  if (args.includes("--plan-only")) {
    exitWithError(
      "--plan-only is no longer supported. Use --plan <inventory> instead.",
    );
    return;
  }
  const workMode = args.includes("--work");
  const workRaw = getArg("--work");
  const workPath = workRaw && !workRaw.startsWith("-") ? workRaw : undefined;
  const auto = args.includes("--auto") || args.includes("--no-interaction");
  const skipFingerprint = args.includes("--skip-fingerprint");
  const resetState = args.includes("--reset");
  const cleanupMode = args.includes("--cleanup");
  const groupFilter = getArg("--group");
  const initMode = args.includes("--init");
  const showPlan = args.includes("--show-plan");
  let executionPreference: ExecutionPreference;
  try {
    executionPreference = parseExecutionPreference(args);
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error));
    return;
  }
  const rawThreshold = getArg("--review-threshold");
  const reviewThreshold = rawThreshold !== undefined ? Number(rawThreshold) : 30;
  if (Number.isNaN(reviewThreshold)) {
    exitWithError(`Invalid --review-threshold value: ${rawThreshold}`);
    return;
  }
  if (initMode && groupFilter) {
    exitWithError("--init and --group are mutually exclusive.");
    return;
  }
  if (inventoryPath && workMode) {
    exitWithError(
      "--plan and --work are mutually exclusive. Use --plan <inventory> to bootstrap from inventory, or --work <plan> to execute an existing plan.",
    );
    return;
  }
  if (workMode && !workPath) {
    exitWithError("--work requires a plan path. Usage: --work <plan.md>");
    return;
  }
  if (cleanupMode && !workMode) {
    exitWithError("--cleanup requires --work <plan>.");
    return;
  }
  if (showPlan && !workMode) {
    exitWithError("--show-plan requires --work <plan>.");
    return;
  }
  if (!inventoryPath && !workMode) {
    exitWithError(
      "Provide --plan <inventory> to bootstrap from inventory, or --work <plan> to execute an existing plan.",
    );
    return;
  }

  await assertGitRepo(cwd);

  // 1. Load skill prompts
  const skillsDir = resolve(import.meta.dirname, "..", "skills");
  const builtInTdd = readFileSync(resolve(skillsDir, "tdd.md"), "utf-8");
  const builtInReview = readFileSync(resolve(skillsDir, "deep-review.md"), "utf-8");
  const builtInVerify = readFileSync(resolve(skillsDir, "verify.md"), "utf-8");
  const orchrc = loadAndResolveOrchrConfig(cwd);
  const tddSkill = resolveSkillValue(orchrc.skills.tdd, builtInTdd);
  const reviewSkill = resolveSkillValue(orchrc.skills.review, builtInReview);
  const verifySkill = resolveSkillValue(orchrc.skills.verify, builtInVerify);
  const gapDisabled = "disabled" in orchrc.skills.gap;
  const planDisabled = "disabled" in orchrc.skills.plan;
  const orchrcSummary = buildOrchrSummary(orchrc);
  const orchDir = resolve(cwd, ".orch");

  // 2. Init (if requested) → fingerprint + brief
  if (initMode) {
    const initProfile = await runInit(cwd);
    if (initProfile) {
      mkdirSync(orchDir, { recursive: true });
      writeFileSync(resolve(orchDir, "init-profile.md"), profileToMarkdown(initProfile));
    }
  }

  // Buffer log output until ink mounts — any pre-ink console.log breaks cursor tracking
  const earlyLog: string[] = [];
  const origLog = log;
  log = (...args: unknown[]) => {
    earlyLog.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };

  const { brief } = await runFingerprint({
    cwd,
    outputDir: orchDir,
    skip: skipFingerprint,
    forceRefresh: !skipFingerprint,
  });

  // 3. Resolve plan path — generate from inventory or use existing
  const provider = parseProviderFlag(args);
  const agentConfig = resolveAllAgentConfigs(orchrc.agents, provider);
  let planPath: string;
  let planContent: string | undefined;
  let executionMode: ExecutionMode;
  try {
    if (workMode) {
      planPath = resolve(workPath!);
      if (executionPreference !== "auto") {
        throw new Error(
          "Execution mode overrides are not supported with --work until plan metadata is available.",
        );
      }
      planContent = readFileSync(planPath, "utf-8");
      executionMode = resolvePlannedWorkExecutionMode(planContent, executionPreference);
      printExecutionModeBanner(log, executionMode);
    } else {
      const inputPath = resolve(inventoryPath!);
      const srcContent = readFileSync(inputPath, "utf-8");

      if (isPlanFormat(srcContent)) {
        log(`${a.dim}Input is already a plan — using directly.${a.reset}`);
        planPath = inputPath;
        planContent = srcContent;
        executionMode = resolvePlannedWorkExecutionMode(planContent, executionPreference);
        printExecutionModeBanner(log, executionMode);
      } else {
        executionMode = await resolveInventoryExecutionMode({
          executionPreference,
          requestContent: srcContent,
          agentConfig,
          cwd,
        });
        printExecutionModeBanner(log, executionMode);
        const spawnPlanGenerator = planGeneratorSpawnerFactory({ agentConfig, cwd });
        if (executionMode === "direct") {
          planPath = inputPath;
          planContent = srcContent;
        } else {
          planPath = await doGeneratePlan(
            inputPath,
            brief,
            orchDir,
            log,
            spawnPlanGenerator,
            executionMode,
          );
        }
      }
    }
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error));
    return;
  }

  // 4. Derive per-plan state path
  const activePlanId =
    executionMode === "direct"
      ? resolvePlanId(planPath)
      : ensureCanonicalPlan(planPath, orchDir);
  const branchName = parseBranchFlag(args, activePlanId);
  const stateFile = statePathForPlan(orchDir, activePlanId);
  let cleanup = () => {};
  mkdirSync(resolve(orchDir, "state"), { recursive: true });

  if (resetState) {
    await clearState(stateFile);
    log(`${a.dim}State cleared.${a.reset}`);
  }

  if (cleanupMode) {
    const state = await loadState(stateFile);
    const message = await runCleanup(stateFile, state, cwd);
    for (const line of earlyLog) {
      origLog(line);
    }
    origLog(message);
    exit(0);
    return;
  }

  if (executionMode === "direct") {
    const directGroups = buildDirectExecutionGroups(planContent ?? "", planPath);
    for (const line of earlyLog) {
      origLog(line);
    }
    const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true;
    const hud = createHud(isTTY);
    log = hud.wrapLog(origLog);
    cleanup = () => hud.teardown();
    const planLogPath = logPathForPlan(orchDir, activePlanId);
    const orchestratorConfig = {
      cwd,
      planPath,
      planContent: planContent ?? "",
      brief,
      executionMode,
      executionPreference,
      auto,
      reviewThreshold:
        rawThreshold !== undefined ? reviewThreshold : (orchrc.config.reviewThreshold ?? 30),
      maxReviewCycles: orchrc.config.maxReviewCycles ?? 3,
      maxReplans: orchrc.config.maxReplans ?? 2,
      stateFile,
      logPath: planLogPath,
      tddSkill,
      reviewSkill,
      verifySkill,
      gapDisabled,
      planDisabled: true,
      tddRules: orchrc.rules.tdd,
      defaultProvider: provider,
      agentConfig,
      reviewRules: orchrc.rules.review,
    } satisfies OrchestratorConfig;
    const container = createContainer(orchestratorConfig, hud);
    const orch = container.resolve("runOrchestration");
    cleanup = () => orch.dispose();
    await orch.execute(directGroups);
    cleanup();
    return;
  }

  const runId = randomUUID();
  let registered = false;
  let executionStarted = false;
  await saveState(stateFile, {
    ...(await loadState(stateFile)),
    startedAt: new Date().toISOString(),
    currentPhase: "plan",
  });
  await withRegistryLock(registryPath, async () => {
    await registerRun(registryPath, {
      id: runId,
      pid: process.pid,
      repo: cwd,
      planPath,
      statePath: stateFile,
      branch: branchName,
      startedAt: new Date().toISOString(),
    });
  });
  registered = true;

  // 5. Parse plan + HUD
  const exitWithCleanup = async (code: number): Promise<void> => {
    cleanup();
    exit(code);
  };
  onSignal("SIGINT", () => {
    void exitWithCleanup(130);
  });
  onSignal("SIGTERM", () => {
    void exitWithCleanup(143);
  });

  try {
    const groups = await parsePlan(planPath);

    if (showPlan) {
      for (const line of earlyLog) {
        origLog(line);
      }
      formatPlanSummary(origLog, groups);
      exit(0);
      return;
    }

    const totalSlices = groups.reduce((n, g) => n + g.slices.length, 0);
    const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true;
    const hud = createHud(isTTY);
    hud.update({ totalSlices, completedSlices: 0, startTime: Date.now() });
    log = hud.wrapLog(origLog);
    for (const line of earlyLog) {
      log(line);
    }
    cleanup = () => hud.teardown();

    // 6. Load per-plan state + resume mismatch guard + resolve worktree
    const state: OrchestratorState = await loadState(stateFile);
    const resumeCheck = await checkWorktreeResume(branchName, state);
    if (!resumeCheck.ok) {
      origLog(resumeCheck.message);
      exit(1);
      return;
    }
    // resolveWorktree persists worktree state to disk before returning,
    // so RunOrchestration.execute() will pick it up via persistence.load().
    const {
      cwd: effectiveCwd,
      worktreeInfo,
      skipStash,
    } = await resolveWorktree({
      branchName,
      cwd,
      activePlanId,
      state,
      stateFile,
      log,
    });
    const interactive = !auto && isTTY;

    // 8. Validate group filter
    const startIdx = groupFilter
      ? groups.findIndex((g) => g.name.toLowerCase() === groupFilter.toLowerCase())
      : 0;

    if (groupFilter && startIdx === -1) {
      console.error(
        `No group "${groupFilter}". Available: ${groups.map((g) => g.name).join(", ")}`,
      );
      await exitWithCleanup(1);
      return;
    }

    // Stash unrelated working tree changes (skip if using worktree — it's clean by definition)
    const didStash = skipStash ? false : await stashBackup(cwd);
    if (didStash) {
      log(`${ts()} ${a.dim}Backed up working tree to git stash${a.reset}`);
    }
    const planLogPath = logPathForPlan(orchDir, activePlanId);
    log(`${ts()} ${a.dim}Log file: ${planLogPath}${a.reset}`);
    log(`${ts()} ${a.dim}Initialising agents — this may take a few minutes...${a.reset}`);

    planContent ??= await readFile(planPath, "utf-8");

    // 9. Composition root — wire all ports + use case
    const orchestratorConfig = {
      cwd: effectiveCwd,
      planPath,
      planContent,
      brief,
      executionMode,
      executionPreference,
      auto,
      reviewThreshold:
        rawThreshold !== undefined ? reviewThreshold : (orchrc.config.reviewThreshold ?? 30),
      maxReviewCycles: orchrc.config.maxReviewCycles ?? 3,
      maxReplans: orchrc.config.maxReplans ?? 2,
      stateFile,
      logPath: planLogPath,
      tddSkill,
      reviewSkill,
      verifySkill,
      gapDisabled,
      planDisabled,
      tddRules: orchrc.rules.tdd,
      defaultProvider: provider,
      agentConfig,
      reviewRules: orchrc.rules.review,
    } satisfies OrchestratorConfig;

    const container = createContainer(orchestratorConfig, hud);
    const orch = container.resolve("runOrchestration");
    cleanup = () => orch.dispose();

    // 10. Banner + run
    const remaining = groups.slice(startIdx);

    try {
      executionStarted = true;
      await orch.execute(remaining, {
        onReady: (info) =>
          printStartupBanner(log, {
            planPath,
            brief,
            auto,
            interactive,
            groupFilter,
            worktree: worktreeInfo,
            orchrcSummary,
            tddSessionId: info.tddSessionId,
            reviewSessionId: info.reviewSessionId,
            groups: remaining,
          }),
      });
    } catch (err) {
      if (err instanceof CreditExhaustedError) {
        log(`\n${ts()} ${a.red}Credit exhaustion detected: ${err.message}${a.reset}`);
        await exitWithCleanup(2);
        return;
      }
      if (err instanceof IncompleteRunError) {
        log(`\n${ts()} ${a.red}${err.message}${a.reset}`);
        await exitWithCleanup(1);
        return;
      }
      throw err;
    }

    // 11. Cleanup
    logSection(log, `${a.green}✅ All groups complete + final review done${a.reset}`);
    const status = await getStatus(effectiveCwd);
    log(`\n${status}`);
    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
};

const isEntrypoint =
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.ts$/, "") ===
    new URL(import.meta.url).pathname.replace(/\.ts$/, "");

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
