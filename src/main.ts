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

import { createHash } from "crypto";
import { resolve } from "path";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { readFile } from "fs/promises";
import { parsePlan } from "./plan-parser.js";
import { generatePlan, isPlanFormat, planFileName, planIdFromPath } from "./plan-generator.js";
import {
  loadState,
  clearState,
  statePathForPlan,
  type OrchestratorState,
} from "./state.js";
import { runFingerprint } from "./fingerprint.js";
import {
  a,
  ts,
  BOT_TDD,
  BOT_REVIEW,
  BOT_GAP,
  BOT_VERIFY,
  logSection,
} from "./display.js";
import { Orchestrator, CreditExhaustedError, type OrchestratorConfig } from "./orchestrator.js";
import { runInit, profileToMarkdown } from "./init.js";
import { spawnAgent, spawnTddAgent, spawnReviewAgent, spawnPlanAgentWithSkill, TDD_RULES_REMINDER, REVIEW_RULES_REMINDER } from "./agent-factory.js";
import { getStatus, stashBackup } from "./git.js";
import { assertGitRepo } from "./repo-check.js";


import { createHud } from "./hud.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  maxReviewCycles: 3,
  briefDir: ".orch",
};

let log: (...args: unknown[]) => void = (...args: unknown[]) => console.log(...args);

// ─── Plan generation helper ──────────────────────────────────────────────────

const doGeneratePlan = async (
  inventoryPath: string,
  briefContent: string,
  outputDir: string,
): Promise<string> => {
  log(`${a.bold}Generating plan from inventory...${a.reset}`);
  const planAgent = spawnPlanAgentWithSkill();
  try {
    const { planPath } = await generatePlan(
      inventoryPath,
      briefContent,
      planAgent,
      outputDir,
      inventoryPath,
    );
    log(`${a.green}Plan written to ${planPath}${a.reset}`);
    return planPath;
  } finally {
    planAgent.kill();
  }
};

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
  const orchDir = resolve(cwd, CONFIG.briefDir);

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
    // --work <plan>: explicit path, no fallback
    planPath = resolve(workPath!);
  } else {
    // --plan <input>: generate plan from inventory (or detect it's already a plan)
    const inputPath = resolve(inventoryPath!);
    const srcContent = readFileSync(inputPath, "utf-8");

    if (isPlanFormat(srcContent)) {
      // Already a plan — use directly
      log(`${a.dim}Input is already a plan — using directly.${a.reset}`);
      planPath = inputPath;
    } else {
      planPath = await doGeneratePlan(inputPath, brief, orchDir);
    }
  }

  // 4b. Derive per-plan state path from resolved planPath
  let activePlanId: string;
  try {
    activePlanId = planIdFromPath(planPath);
  } catch {
    // External plan file (e.g. plan.md) — derive stable ID from path hash
    activePlanId = createHash("sha256").update(planPath).digest("hex").slice(0, 6);

    // Copy non-standard plan names to .orch/plan-<id>.md for state scoping
    mkdirSync(orchDir, { recursive: true });
    const canonicalPath = resolve(orchDir, planFileName(activePlanId));
    if (!existsSync(canonicalPath)) {
      writeFileSync(canonicalPath, readFileSync(planPath, "utf-8"));
    }
  }
  const stateFile = statePathForPlan(orchDir, activePlanId);
  mkdirSync(resolve(orchDir, "state"), { recursive: true });

  // 4c. --reset clears the per-plan state file
  if (resetState) {
    await clearState(stateFile);
    log(`${a.dim}State cleared.${a.reset}`);
  }

  // Generate-only mode: --plan without --work
  const generateOnly = !!inventoryPath && !workMode;
  if (generateOnly) {
    // Flush buffered output + final message directly (no HUD in this path)
    for (const line of earlyLog) origLog(line);
    origLog(`Plan written to ${planPath} — review and run with --work`);
    process.exit(0);
  }

  // 4. Parse plan
  const groups = await parsePlan(planPath);

  // 4b. HUD — persistent status bar at bottom of terminal
  const totalSlices = groups.reduce((n, g) => n + g.slices.length, 0);
  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true;
  const hud = createHud(isTTY);
  hud.update({ totalSlices, completedSlices: 0, startTime: Date.now() });
  log = hud.wrapLog(origLog);
  // Replay buffered pre-ink output through ink so it knows about those lines
  for (const line of earlyLog) log(line);

  // 5. Load per-plan state
  let state: OrchestratorState = await loadState(stateFile);

  // 6. Spawn persistent agents with skill system prompts (spawned here, rules reminder awaited after banner)
  const tddAgent = spawnAgent(BOT_TDD, tddSkill);
  const reviewAgent = spawnAgent(BOT_REVIEW, reviewSkill);

  const interactive = !noInteraction && isTTY;

  // 7. Signal handlers + cleanup (delegates to orchestrator after it's constructed)
  let _orch: Orchestrator | null = null;
  const cleanup = () => {
    if (_orch) {
      _orch.cleanup();
    } else {
      hud.teardown();
      tddAgent.kill();
      reviewAgent.kill();
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  // 8. Startup banner
  log(
    `\n${a.bold}🚀 Orchestrator${a.reset} ${a.dim}${new Date().toISOString().slice(0, 16)}${a.reset}`,
  );
  log(`   ${a.dim}Plan${a.reset}    ${planPath}`);
  log(
    `   ${a.dim}Brief${a.reset}   ${brief ? `${a.green}✓${a.reset} .orch/brief.md` : `${a.dim}none${a.reset}`}`,
  );
  log(
    `   ${a.dim}Mode${a.reset}    ${groupFilter ? `start from "${groupFilter}"` : auto ? "automatic" : "interactive"}`,
  );
  log(`   ${BOT_TDD.badge} ${a.dim}persistent (${tddAgent.sessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_REVIEW.badge} ${a.dim}persistent (${reviewAgent.sessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_GAP.badge} ${a.dim}fresh each group${a.reset}`);
  if (interactive)
    log(`   ${a.dim}Press${a.reset} ${a.bold}S${a.reset} ${a.dim}to skip current slice${a.reset}`);

  // Send rules reminders (awaited after banner so UI isn't blocked)
  await Promise.all([
    tddAgent.sendQuiet(TDD_RULES_REMINDER),
    reviewAgent.sendQuiet(REVIEW_RULES_REMINDER),
  ]);

  // 9. Group list with start marker
  const startIdx = groupFilter
    ? groups.findIndex((g) => g.name.toLowerCase() === groupFilter.toLowerCase())
    : 0;

  if (groupFilter && startIdx === -1) {
    console.error(`No group "${groupFilter}". Available: ${groups.map((g) => g.name).join(", ")}`);
    cleanup();
    process.exit(1);
  }

  const remaining = groups.slice(startIdx);
  log("");
  for (let g = 0; g < remaining.length; g++) {
    const grp = remaining[g];
    const slices = grp.slices.map((s) => `${s.number}`).join(", ");
    const marker = g === 0 ? `${a.bold}▸${a.reset}` : " ";
    log(
      `   ${marker} ${a.dim}${String(g + 1).padStart(2)}.${a.reset} ${g === 0 ? a.bold : a.dim}${grp.name}${a.reset} ${a.dim}(${slices})${a.reset}`,
    );
  }
  log("");

  // Stash any unrelated working tree changes to protect them from the TDD bot
  const didStash = await stashBackup(cwd);
  if (didStash) log(`${ts()} ${a.dim}Backed up working tree to git stash${a.reset}`);

  const planContent = await readFile(planPath, "utf-8");

  // 9b. Construct Orchestrator (scaffold — run() not called yet)
  const orchConfig: OrchestratorConfig = {
    cwd,
    planPath,
    planContent,
    brief,
    noInteraction,
    auto,
    reviewThreshold,
    maxReviewCycles: CONFIG.maxReviewCycles,
    stateFile,
    tddSkill,
    reviewSkill,
    verifySkill,
  };
  _orch = new Orchestrator(
    orchConfig,
    state,
    hud,
    log,
    tddAgent,
    reviewAgent,
    async () => spawnTddAgent(tddSkill),
    async () => spawnReviewAgent(reviewSkill),
    async () => spawnAgent(BOT_VERIFY, verifySkill),
  );
  if (interactive) _orch.setupKeyboardHandlers();

  // 10. Run the orchestrator
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
