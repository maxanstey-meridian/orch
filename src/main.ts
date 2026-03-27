#!/usr/bin/env npx ts-node
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
 *   npx ts-node src/main.ts --work plan.md --auto             # no inter-group prompts
 *   npx ts-node src/main.ts --work plan.md --no-interaction   # suppress all prompts
 *   npx ts-node src/main.ts --work plan.md --reset            # clear state and re-run
 *   npx ts-node src/main.ts --init --plan inventory.md        # interactive project init
 */

import { resolve } from "path";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { parsePlan } from "./plan-parser.js";
import { isPlanFormat, ensureCanonicalPlan, doGeneratePlan } from "./plan-generator.js";
import { loadState, clearState, statePathForPlan, type OrchestratorState } from "./state.js";
import { runFingerprint } from "./fingerprint.js";
import { a, ts, logSection, printStartupBanner } from "./display.js";
import { Orchestrator, CreditExhaustedError, type OrchestratorConfig } from "./orchestrator.js";
import { runInit, profileToMarkdown } from "./init.js";
import { spawnPlanAgentWithSkill } from "./agent-factory.js";
import { getStatus, stashBackup } from "./git.js";
import { assertGitRepo } from "./repo-check.js";
import { parseBranchFlag } from "./cli-args.js";
import { createHud } from "./hud.js";

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
  const auto = args.includes("--auto");
  const skipFingerprint = args.includes("--skip-fingerprint");
  const noInteraction = args.includes("--no-interaction");
  const resetState = args.includes("--reset");
  const groupFilter = getArg("--group");
  const initMode = args.includes("--init");
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
  if (!inventoryPath && !workMode) {
    console.error(
      "Provide --plan <inventory> to generate a plan, or --work <plan> to execute an existing one.",
    );
    process.exit(1);
  }

  // 1. Load skill prompts
  const skillsDir = resolve(import.meta.dirname, "..", "skills");
  const tddSkill = readFileSync(resolve(skillsDir, "tdd.md"), "utf-8");
  const reviewSkill = readFileSync(resolve(skillsDir, "deep-review.md"), "utf-8");
  const verifySkill = readFileSync(resolve(skillsDir, "verify.md"), "utf-8");

  const cwd = process.cwd();
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
      planPath = await doGeneratePlan(inputPath, brief, orchDir, log, spawnPlanAgentWithSkill);
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

  // Generate-only mode: --plan without --work
  const generateOnly = !!inventoryPath && !workMode;
  if (generateOnly) {
    for (const line of earlyLog) origLog(line);
    origLog(`Plan written to ${planPath} — review and run with --work`);
    process.exit(0);
  }

  // 5. Parse plan + HUD
  const groups = await parsePlan(planPath);
  const totalSlices = groups.reduce((n, g) => n + g.slices.length, 0);
  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true;
  const hud = createHud(isTTY);
  hud.update({ totalSlices, completedSlices: 0, startTime: Date.now() });
  log = hud.wrapLog(origLog);
  for (const line of earlyLog) log(line);

  // 6. Load per-plan state
  const state: OrchestratorState = await loadState(stateFile);
  const interactive = !noInteraction && isTTY;

  // 7. Signal handlers + cleanup
  // If SIGINT arrives during create(), _orch is null and spawned agents aren't
  // tracked here. process.exit() follows immediately, which reaps child processes.
  let _orch: Orchestrator | null = null;
  const cleanup = () => {
    if (_orch) {
      _orch.cleanup();
    } else {
      hud.teardown();
    }
  };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  // 8. Validate group filter
  const startIdx = groupFilter
    ? groups.findIndex((g) => g.name.toLowerCase() === groupFilter.toLowerCase())
    : 0;

  if (groupFilter && startIdx === -1) {
    console.error(`No group "${groupFilter}". Available: ${groups.map((g) => g.name).join(", ")}`);
    cleanup();
    process.exit(1);
  }

  // Stash unrelated working tree changes
  const didStash = await stashBackup(cwd);
  if (didStash) log(`${ts()} ${a.dim}Backed up working tree to git stash${a.reset}`);

  const planContent = await readFile(planPath, "utf-8");

  // 9. Construct Orchestrator — spawns + reminds agents internally
  _orch = await Orchestrator.create(
    { cwd, planPath, planContent, brief, noInteraction, auto, reviewThreshold, maxReviewCycles: 3, stateFile, tddSkill, reviewSkill, verifySkill } satisfies OrchestratorConfig,
    state, hud, log,
  );
  if (interactive) _orch.setupKeyboardHandlers();

  // 10. Banner + group list
  const remaining = groups.slice(startIdx);
  printStartupBanner(log, {
    planPath, brief, auto, interactive, groupFilter,
    tddSessionId: _orch.tddAgent.sessionId,
    reviewSessionId: _orch.reviewAgent.sessionId,
    groups: remaining,
  });

  // 11. Run
  try {
    await _orch.run(remaining, 0);
  } catch (err) {
    if (err instanceof CreditExhaustedError) {
      log(`\n${ts()} ${a.red}Credit exhaustion detected: ${err.message}${a.reset}`);
      cleanup();
      process.exit(2);
    }
    throw err;
  }

  // 12. Cleanup
  logSection(log, `${a.green}✅ All groups complete + final review done${a.reset}`);
  const status = await getStatus(cwd);
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
