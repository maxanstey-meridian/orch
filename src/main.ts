#!/usr/bin/env npx ts-node
// smoke test
/**
 * main.ts — TDD orchestrator CLI
 *
 * Wires tested leaf modules into a procedural pipeline.
 * No dep injection, no framework — reads top-to-bottom.
 *
 * Usage:
 *   npx ts-node src/main.ts --plan inventory.md              # generate plan and exit
 *   npx ts-node src/main.ts --work plan.md                    # execute a plan
 *   npx ts-node src/main.ts --work plan.md --group Auth       # start from group
 *   npx ts-node src/main.ts --work plan.md --auto             # auto-accept all prompts (--no-interaction is an alias)
 *   npx ts-node src/main.ts --work plan.json --show-plan       # inspect plan structure
 *   npx ts-node src/main.ts --work plan.md --reset            # clear state and re-run
 *   npx ts-node src/main.ts --init --plan inventory.md        # interactive project init
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { OrchestratorConfig } from "#domain/config.js";
import { CreditExhaustedError, IncompleteRunError } from "#domain/errors.js";
import { parseBranchFlag, parseProviderFlag } from "#infrastructure/cli/cli-args.js";
import {
  loadAndResolveOrchrConfig,
  resolveSkillValue,
  buildOrchrSummary,
} from "#infrastructure/config/orchrc.js";
import { planGeneratorSpawnerFactory } from "#infrastructure/factories.js";
import { runFingerprint } from "#infrastructure/fingerprint.js";
import { getStatus, stashBackup } from "#infrastructure/git/git.js";
import { assertGitRepo } from "#infrastructure/git/repo-check.js";
import { resolveWorktree } from "#infrastructure/git/worktree-setup.js";
import { checkWorktreeResume, runCleanup } from "#infrastructure/git/worktree.js";
import {
  isPlanFormat,
  ensureCanonicalPlan,
  doGeneratePlan,
} from "#infrastructure/plan/plan-generator.js";
import { parsePlan } from "#infrastructure/plan/plan-parser.js";
import {
  loadState,
  clearState,
  statePathForPlan,
  type OrchestratorState,
} from "#infrastructure/state/state.js";
import { a, ts, logSection, printStartupBanner, formatPlanSummary } from "#ui/display.js";
import { createHud } from "#ui/hud.js";
import { runInit, profileToMarkdown } from "#ui/init.js";
import { createContainer } from "./composition-root.js";

let log: (...args: unknown[]) => void = (...args: unknown[]) => console.log(...args);

// ─── Main ────────────────────────────────────────────────────────────────────

const main = async () => {
  await assertGitRepo(process.cwd());

  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const inventoryPath = getArg("--plan");
  if (args.includes("--resume")) {
    console.error("--resume is no longer supported. Use --work <plan> instead.");
    process.exit(1);
  }
  if (args.includes("--plan-only")) {
    console.error(
      "--plan-only is no longer supported. Use --plan instead (it generates and exits by default).",
    );
    process.exit(1);
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
  const rawThreshold = getArg("--review-threshold");
  const reviewThreshold = rawThreshold !== undefined ? Number(rawThreshold) : 30;
  if (Number.isNaN(reviewThreshold)) {
    console.error(`Invalid --review-threshold value: ${rawThreshold}`);
    process.exit(1);
  }
  if (initMode && groupFilter) {
    console.error("--init and --group are mutually exclusive.");
    process.exit(1);
  }
  if (inventoryPath && workMode) {
    console.error(
      "--plan and --work are mutually exclusive. Use --plan to generate, then --work to execute.",
    );
    process.exit(1);
  }
  if (workMode && !workPath) {
    console.error("--work requires a plan path. Usage: --work <plan.md>");
    process.exit(1);
  }
  if (cleanupMode && !workMode) {
    console.error("--cleanup requires --work <plan>.");
    process.exit(1);
  }
  if (showPlan && !workMode) {
    console.error("--show-plan requires --work <plan>.");
    process.exit(1);
  }
  if (!inventoryPath && !workMode) {
    console.error(
      "Provide --plan <inventory> to generate a plan, or --work <plan> to execute an existing one.",
    );
    process.exit(1);
  }

  // 1. Load skill prompts
  const skillsDir = resolve(import.meta.dirname, "..", "skills");
  const builtInTdd = readFileSync(resolve(skillsDir, "tdd.md"), "utf-8");
  const builtInReview = readFileSync(resolve(skillsDir, "deep-review.md"), "utf-8");
  const builtInVerify = readFileSync(resolve(skillsDir, "verify.md"), "utf-8");

  const cwd = process.cwd();
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
  let planPath: string;

  if (workMode) {
    planPath = resolve(workPath!);
  } else {
    const inputPath = resolve(inventoryPath!);
    const srcContent = readFileSync(inputPath, "utf-8");

    if (isPlanFormat(srcContent)) {
      log(`${a.dim}Input is already a plan — using directly.${a.reset}`);
      planPath = inputPath;
    } else {
      const spawnPlanGenerator = planGeneratorSpawnerFactory({ provider, cwd });
      planPath = await doGeneratePlan(inputPath, brief, orchDir, log, spawnPlanGenerator);
    }
  }

  // 4. Derive per-plan state path
  const activePlanId = ensureCanonicalPlan(planPath, orchDir);
  const branchName = parseBranchFlag(args, activePlanId);
  const stateFile = statePathForPlan(orchDir, activePlanId);
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
    process.exit(0);
  }

  // Generate-only mode: --plan without --work
  const generateOnly = !!inventoryPath && !workMode;
  if (generateOnly) {
    for (const line of earlyLog) {
      origLog(line);
    }
    origLog(`Plan written to ${planPath} — review and run with --work`);
    process.exit(0);
  }

  // 5. Parse plan + HUD
  const groups = await parsePlan(planPath);

  if (showPlan) {
    for (const line of earlyLog) {
      origLog(line);
    }
    formatPlanSummary(origLog, groups);
    process.exit(0);
  }

  const totalSlices = groups.reduce((n, g) => n + g.slices.length, 0);
  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true;
  const hud = createHud(isTTY);
  hud.update({ totalSlices, completedSlices: 0, startTime: Date.now() });
  log = hud.wrapLog(origLog);
  for (const line of earlyLog) {
    log(line);
  }

  // 6. Load per-plan state + resume mismatch guard + resolve worktree
  const state: OrchestratorState = await loadState(stateFile);
  const resumeCheck = await checkWorktreeResume(branchName, state);
  if (!resumeCheck.ok) {
    origLog(resumeCheck.message);
    process.exit(1);
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

  // 7. Signal handlers + cleanup
  // cleanup is set to hud.teardown initially, then upgraded to orch.dispose()
  // after the container is created (kills agents + tears down HUD).
  let cleanup = () => hud.teardown();
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  // 8. Validate group filter
  const startIdx = groupFilter
    ? groups.findIndex((g) => g.name.toLowerCase() === groupFilter.toLowerCase())
    : 0;

  if (groupFilter && startIdx === -1) {
    console.error(`No group "${groupFilter}". Available: ${groups.map((g) => g.name).join(", ")}`);
    cleanup();
    process.exit(1);
  }

  // Stash unrelated working tree changes (skip if using worktree — it's clean by definition)
  const didStash = skipStash ? false : await stashBackup(cwd);
  if (didStash) {
    log(`${ts()} ${a.dim}Backed up working tree to git stash${a.reset}`);
  }
  log(`${ts()} ${a.dim}Initialising agents — this may take a few minutes...${a.reset}`);

  const planContent = await readFile(planPath, "utf-8");

  // 9. Composition root — wire all ports + use case
  const orchestratorConfig = {
    cwd: effectiveCwd,
    planPath,
    planContent,
    brief,
    auto,
    reviewThreshold:
      rawThreshold !== undefined ? reviewThreshold : (orchrc.config.reviewThreshold ?? 30),
    maxReviewCycles: orchrc.config.maxReviewCycles ?? 3,
    maxReplans: orchrc.config.maxReplans ?? 2,
    stateFile,
    tddSkill,
    reviewSkill,
    verifySkill,
    gapDisabled,
    planDisabled,
    tddRules: orchrc.rules.tdd,
    provider,
    reviewRules: orchrc.rules.review,
  } satisfies OrchestratorConfig;

  const container = createContainer(orchestratorConfig, hud);
  const orch = container.resolve("runOrchestration");
  cleanup = () => orch.dispose();

  // 10. Banner + run
  const remaining = groups.slice(startIdx);

  try {
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
      cleanup();
      process.exit(2);
    }
    if (err instanceof IncompleteRunError) {
      log(`\n${ts()} ${a.red}${err.message}${a.reset}`);
      cleanup();
      process.exit(1);
    }
    throw err;
  }

  // 11. Cleanup
  logSection(log, `${a.green}✅ All groups complete + final review done${a.reset}`);
  const status = await getStatus(effectiveCwd);
  log(`\n${status}`);
  cleanup();
  await clearState(stateFile);
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
