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
import { parsePlan, type Slice } from "./plan-parser.js";
import { generatePlan, isPlanFormat, planFileName, planIdFromPath } from "./plan-generator.js";
import {
  loadState,
  saveState,
  clearState,
  statePathForPlan,
  type OrchestratorState,
} from "./state.js";
import { runFingerprint } from "./fingerprint.js";
import { buildTddPrompt, buildCommitSweepPrompt, buildReviewPrompt, buildGapPrompt, buildFinalPasses, withBrief } from "./prompts.js";
import { a, ts, BOT_TDD, BOT_REVIEW, BOT_GAP, BOT_FINAL, BOT_VERIFY, BOT_PLAN, logSection, printSliceIntro } from "./display.js";
import { makeStreamer, type Streamer } from "./streamer.js";
import { Orchestrator, type OrchestratorConfig } from "./orchestrator.js";
import { runInit, profileToMarkdown, createAsk } from "./init.js";
import { createAgent, type AgentProcess, type AgentResult, type AgentStyle } from "./agent.js";
import { captureRef, hasChanges, getStatus, hasDirtyTree, stashBackup } from "./git.js";
import { assertGitRepo } from "./repo-check.js";
import { isCleanReview } from "./review-check.js";

import { detectCreditExhaustion } from "./credit-detection.js";
import { measureDiff } from "./review-threshold.js";
// interrupt + skip + stdin-dispatcher replaced by HUD keyboard handling (ink useInput)
import { createHud } from "./hud.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  maxReviewCycles: 3,
  briefDir: ".orch",
};

let log: (...args: unknown[]) => void = (...args: unknown[]) => console.log(...args);

// ─── Agent helpers ───────────────────────────────────────────────────────────

const BASE_FLAGS = ["--dangerously-skip-permissions"] as const;
const PLAN_FLAGS = ["--permission-mode", "plan"] as const;

const spawnAgent = (style: AgentStyle, systemPrompt?: string): AgentProcess =>
  createAgent({
    command: "claude",
    args: [
      ...BASE_FLAGS,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ],
    style,
  });

export const spawnPlanAgent = (style: AgentStyle, systemPrompt?: string): AgentProcess =>
  createAgent({
    command: "claude",
    args: [
      ...PLAN_FLAGS,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ],
    style,
  });

const planSkillContent = readFileSync(resolve(import.meta.dirname, "..", "skills", "plan.md"), "utf-8");

export const spawnPlanAgentWithSkill = (): AgentProcess =>
  spawnPlanAgent(BOT_PLAN, planSkillContent);

const TDD_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. RUN TESTS WITH BASH. Use your Bash tool to execute tests. Read the actual output. Do not narrate "RED confirmed" or "GREEN" without executing. No exceptions.
2. COMMIT WHEN DONE. After all behaviours are GREEN, run the full test suite, then git add + git commit. Uncommitted work is invisible to the review agent.
3. STAY IN SCOPE. Only modify files relevant to your current task. Do not touch, revert, or "clean up" unrelated files. Use git add with specific filenames, never git add . or git add -A.`;

const REVIEW_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. ONLY REVIEW THE DIFF. Review files changed in the diff. Ignore unrelated uncommitted changes in the working tree — they belong to the operator.
2. DO NOT SUGGEST REVERTING unrelated files (skill files, config, HUD changes) that weren't part of the slice.
3. If the diff is empty and HEAD hasn't moved, respond with REVIEW_CLEAN. Do not claim work is missing if it was committed in prior commits.`;

const spawnTddAgent = async (skill: string): Promise<AgentProcess> => {
  const agent = spawnAgent(BOT_TDD, skill);
  await agent.sendQuiet(TDD_RULES_REMINDER);
  return agent;
};

const spawnReviewAgent = async (skill: string): Promise<AgentProcess> => {
  const agent = spawnAgent(BOT_REVIEW, skill);
  await agent.sendQuiet(REVIEW_RULES_REMINDER);
  return agent;
};

// ─── Prompt helper ───────────────────────────────────────────────────────────

// Lazy init — readline on stdout interferes with ink's cursor tracking
let _rl: ReturnType<typeof createAsk> | null = null;
const getRl = () => {
  if (!_rl) _rl = createAsk();
  return _rl;
};
const ask = (prompt: string) => getRl().ask(prompt);

// ─── Interactive follow-up ───────────────────────────────────────────────────

const followUpIfNeeded = async (
  result: AgentResult,
  agent: AgentProcess,
  noInteraction: boolean,
  createStreamer: (style: AgentStyle) => Streamer = (style) => makeStreamer(style),
  toolUseHandler?: (summary: string) => void,
  askUser: (prompt: string) => Promise<string> = ask,
  maxFollowUps = 3,
): Promise<AgentResult> => {
  let current = result;
  let followUps = 0;

  while (current.needsInput && !noInteraction && followUps < maxFollowUps) {
    log(`\n${ts()} ${a.yellow}Bot is asking for input ↑${a.reset}`);
    const answer = await askUser(`${a.bold}Your response${a.reset} (or Enter to skip): `);

    const s = createStreamer(agent.style);
    if (!answer.trim()) {
      log(`${ts()} ${a.dim}skipped — telling bot to proceed autonomously${a.reset}`);
      current = await agent.send(
        "No preference — proceed with your best judgement. Make the decision yourself and continue implementing.",
        s,
        toolUseHandler,
      );
    } else {
      current = await agent.send(answer, s, toolUseHandler);
    }
    s.flush();
    followUps++;
  }

  return current;
};

// ─── Plan-then-execute ──────────────────────────────────────────────────────

const buildPlanPrompt = (sliceContent: string): string =>
  `You are a planning agent. Explore the codebase and produce a step-by-step TDD execution plan for the following slice.

## Plan Slice
${sliceContent}

## Instructions
1. Read the relevant files to understand current state.
2. Output numbered RED→GREEN cycles. Each cycle: one failing test, then minimal code to pass.
3. Do NOT write any code — plan only.`;

type PlanThenExecuteDeps = {
  sliceContent: string;
  planAgent: AgentProcess;
  tddAgent: AgentProcess;
  brief: string;
  makePlanStreamer: () => Streamer;
  makeExecuteStreamer: () => Streamer;
  withInterrupt: <T>(agent: AgentProcess, fn: () => Promise<T>) => Promise<T>;
  isSkipped: () => boolean;
  isHardInterrupted: () => string | null;
  onToolUse?: (summary: string) => void;
  log: (...args: unknown[]) => void;
  noInteraction?: boolean;
  askUser?: (prompt: string) => Promise<string>;
  onPlanReady?: () => void;
};

type PlanThenExecuteResult = {
  tddResult: AgentResult;
  skipped: boolean;
  hardInterrupt?: string;
  replan?: boolean;
};

export const planThenExecute = async (
  deps: PlanThenExecuteDeps,
): Promise<PlanThenExecuteResult> => {
  // ── Plan phase ──
  const planPrompt = buildPlanPrompt(deps.sliceContent);
  const ps = deps.makePlanStreamer();
  const planResult = await deps.withInterrupt(deps.planAgent, () =>
    deps.planAgent.send(planPrompt, ps, deps.onToolUse),
  );
  ps.flush();

  if (deps.isSkipped()) {
    deps.planAgent.kill();
    return { tddResult: planResult, skipped: true };
  }

  const hardInterruptGuidance = deps.isHardInterrupted();
  if (hardInterruptGuidance) {
    deps.planAgent.kill();
    return { tddResult: planResult, skipped: false, hardInterrupt: hardInterruptGuidance };
  }

  deps.planAgent.kill();

  // Extract plan text — prefer structured planText, fall back to assistantText
  const plan = planResult.planText ?? planResult.assistantText ?? "";

  // ── Confirmation gate ──
  let operatorGuidance = "";
  if (!deps.noInteraction && deps.askUser) {
    const planLines = plan.split("\n");
    const MAX_PREVIEW = 30;
    const preview = planLines.slice(0, MAX_PREVIEW).join("\n");
    deps.log(`${BOT_PLAN.badge} plan ready`);
    deps.onPlanReady?.();
    deps.log(preview);
    if (planLines.length > MAX_PREVIEW) {
      deps.log(`... (truncated, ${planLines.length} lines)`);
    }
    const answer = await deps.askUser("Accept plan? (y)es / (e)dit / (r)eplan: ");
    if (answer.startsWith("r")) {
      return { tddResult: planResult, skipped: false, replan: true };
    }
    if (answer.startsWith("e")) {
      operatorGuidance = await deps.askUser("Guidance for execution: ");
    }
    // "y", empty, or after guidance — fall through to execute
  }

  // ── Execute phase ──
  deps.log(`${BOT_TDD.badge} executing plan...`);
  const executePrompt = operatorGuidance
    ? `Operator guidance: ${operatorGuidance}\n\nExecute this plan:\n\n${plan}`
    : `Execute this plan:\n\n${plan}`;
  const es = deps.makeExecuteStreamer();
  const tddResult = await deps.withInterrupt(deps.tddAgent, () =>
    deps.tddAgent.send(executePrompt, es, deps.onToolUse),
  );
  es.flush();

  if (deps.isSkipped()) {
    return { tddResult, skipped: true };
  }

  const execInterrupt = deps.isHardInterrupted();
  if (execInterrupt) {
    return { tddResult, skipped: false, hardInterrupt: execInterrupt };
  }

  return { tddResult, skipped: false };
};

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
    if (_rl) _rl.close();
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
  let globalSlicesCompleted = 0;
  hud.update({ totalSlices, completedSlices: 0, startTime: Date.now() });
  log = hud.wrapLog(origLog);
  // Replay buffered pre-ink output through ink so it knows about those lines
  for (const line of earlyLog) log(line);
  const hudWriter = hud.createWriter();
  let _activityShowing = false;
  const onToolUse = (summary: string) => {
    _activityShowing = true;
    hud.setActivity(summary);
  };

  const boundMakeStreamer = (style: AgentStyle): Streamer => {
    const base = makeStreamer(style, hudWriter);
    // Clear activity spinner once on first text chunk, not on every chunk
    const wrapped = (text: string) => {
      if (_activityShowing) {
        _activityShowing = false;
        hud.setActivity("");
      }
      base(text);
    };
    wrapped.flush = base.flush;
    return wrapped;
  };

  // 5. Load per-plan state
  let state: OrchestratorState = await loadState(stateFile);

  // 6. Spawn persistent agents with skill system prompts (spawned here, rules reminder awaited after banner)
  let tddAgent = spawnAgent(BOT_TDD, tddSkill);
  let reviewAgent = spawnAgent(BOT_REVIEW, reviewSkill);
  const tddFirstMessage = { value: true };
  const reviewFirstMessage = { value: true };

  // 6b. Keyboard handling — all via ink's useInput in the HUD
  const interactive = !noInteraction && isTTY;
  let interruptTarget: AgentProcess | null = null;
  let sliceSkippable = false;
  let sliceSkipFlag = false;

  let hardInterruptPending: string | null = null;

  if (interactive) {
    hud.onKey((key) => {
      if (key === "g" && interruptTarget) {
        hud.startPrompt("guide");
      } else if (key === "i" && interruptTarget) {
        hud.startPrompt("interrupt");
      } else if (key === "s" && sliceSkippable) {
        sliceSkipFlag = !sliceSkipFlag;
        hud.setSkipping(sliceSkipFlag);
      } else if (key === "q" || key === "\x03") {
        cleanup();
        process.exit(130);
      }
    });
    hud.onInterruptSubmit((text, mode) => {
      if (!interruptTarget) return;
      if (mode === "guide") {
        // Soft: inject guidance, agent sees it on next turn
        interruptTarget.inject(text);
        log(`${ts()} ${a.cyan}💬 Guidance sent (will apply on next turn)${a.reset}`);
      } else {
        // Hard: store message, kill agent — respawn logic picks it up
        hardInterruptPending = text;
        interruptTarget.kill();
        log(`${ts()} ${a.yellow}⚡ Interrupting agent...${a.reset}`);
      }
    });
  }

  const withInterrupt = async <T>(agent: AgentProcess, fn: () => Promise<T>): Promise<T> => {
    interruptTarget = agent;
    try {
      return await fn();
    } finally {
      interruptTarget = null;
    }
  };

  // 7. Signal handlers + cleanup
  const cleanup = () => {
    hud.teardown();
    tddAgent.kill();
    reviewAgent.kill();
    if (_rl) _rl.close();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  // Closure over mutable `state` — always saves the latest value
  const exitOnCreditExhaustion = async (result: AgentResult, agent: AgentProcess) => {
    const signal = detectCreditExhaustion(result, agent.stderr);
    if (!signal) return;
    log(`\n${ts()} ${a.red}Credit exhaustion detected: ${signal.message}${a.reset}`);
    await saveState(stateFile, state);
    if (signal.kind === "mid-response") {
      log(
        `${ts()} ${a.yellow}Agent was interrupted mid-response. The current slice will be re-run on resume.${a.reset}`,
      );
    }
    cleanup();
    process.exit(2);
  };

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

  const runBaseSha = await captureRef(cwd);
  const planContent = await readFile(planPath, "utf-8");

  // 9b. Construct Orchestrator (scaffold — run() not called yet)
  const orchConfig: OrchestratorConfig = {
    cwd, planPath, planContent, brief,
    noInteraction, auto, reviewThreshold,
    maxReviewCycles: CONFIG.maxReviewCycles,
    stateFile, tddSkill, reviewSkill, verifySkill,
  };
  const _orch = new Orchestrator(
    orchConfig, state, hud, log,
    tddAgent, reviewAgent,
    async () => spawnAgent(BOT_TDD, tddSkill),
    async () => spawnAgent(BOT_REVIEW, reviewSkill),
    { hasDirtyTree, captureRef, hasChanges },
    detectCreditExhaustion,
    saveState,
    isCleanReview,
    async () => spawnAgent(BOT_VERIFY, verifySkill),
    measureDiff,
  );
  // Sync helpers — bridge inline mutable state with orchestrator fields until run() takes over
  const syncToOrch = () => {
    _orch.tddAgent = tddAgent;
    _orch.reviewAgent = reviewAgent;
    _orch.tddIsFirst = tddFirstMessage.value;
    _orch.reviewIsFirst = reviewFirstMessage.value;
    _orch.sliceSkipFlag = sliceSkipFlag;
    _orch.state = state;
  };
  const syncFromOrch = () => {
    tddFirstMessage.value = _orch.tddIsFirst;
    reviewFirstMessage.value = _orch.reviewIsFirst;
  };

  // 10. Group loop
  for (let i = 0; i < remaining.length; i++) {
    const group = remaining[i];

    // Skip entire group if all its slices are already completed
    const allSlicesDone =
      state.lastCompletedSlice !== undefined &&
      group.slices.every((s) => s.number <= state.lastCompletedSlice!);
    if (allSlicesDone) {
      log(`\n${ts()} ${a.dim}⏩ Group "${group.name}" already completed — skipping${a.reset}`);
      globalSlicesCompleted += group.slices.length;
      hud.update({ completedSlices: globalSlicesCompleted });
      continue;
    }

    logSection(log,
      `Group: ${group.name} — ${group.slices.map((s: Slice) => `Slice ${s.number}`).join(", ")}`,
    );
    hud.update({
      groupName: group.name,
      groupSliceCount: group.slices.length,
      groupCompleted: 0,
    });

    const groupBaseSha = await captureRef(cwd);

    // Skip signal — active for the entire group (slices, gap analysis, commit sweep).
    sliceSkippable = true;
    sliceSkipFlag = false;

    // ── Slice loop ──
    let reviewBase = groupBaseSha;
    let groupSlicesCompleted = 0;
    for (const slice of group.slices) {
      if (state.lastCompletedSlice !== undefined && slice.number <= state.lastCompletedSlice) {
        log(
          `\n${ts()} ${a.dim}⏭ Slice ${slice.number}: ${slice.title} — already completed${a.reset}`,
        );
        groupSlicesCompleted++;
        globalSlicesCompleted++;
        hud.update({
          completedSlices: globalSlicesCompleted,
          groupCompleted: groupSlicesCompleted,
        });
        continue;
      }

      printSliceIntro(log, slice);
      hud.update({
        currentSlice: { number: slice.number },
      });

      const doSkip = async () => {
        sliceSkipFlag = false;
        hud.setSkipping(false);
        log(`\n${ts()} ${a.yellow}⏭ Slice ${slice.number} skipped by operator${a.reset}`);
        tddAgent.kill();
        tddAgent = await spawnTddAgent(tddSkill);
        tddFirstMessage.value = true;
        reviewFirstMessage.value = true;
        state = { ...state, lastCompletedSlice: slice.number };
        await saveState(stateFile, state);
        groupSlicesCompleted++;
        globalSlicesCompleted++;
        hud.update({
          completedSlices: globalSlicesCompleted,
          groupCompleted: groupSlicesCompleted,
        });
      };

      // Resume support: TDD done but review was interrupted
      const alreadyImplemented =
        state.lastSliceImplemented !== undefined &&
        slice.number <= state.lastSliceImplemented &&
        (state.lastCompletedSlice === undefined || slice.number > state.lastCompletedSlice);

      if (alreadyImplemented) {
        // Restore the pre-TDD baseline so review can diff the actual work
        if (state.reviewBaseSha) reviewBase = state.reviewBaseSha;
        log(
          `${ts()} ${a.dim}⏩ TDD already ran for Slice ${slice.number} — resuming review${a.reset}`,
        );
      } else {
        // Capture baseline BEFORE TDD runs — verify needs to diff against pre-TDD state
        const verifyBaseSha = await captureRef(cwd);

        // ── Plan phase (with replan loop) ──
        let replanAttempts = 0;
        const MAX_REPLANS = 2;
        let pteResult: Awaited<ReturnType<typeof planThenExecute>>;
        do {
          log(`${ts()} ${BOT_PLAN.badge} ${a.white}${replanAttempts > 0 ? "replanning..." : "planning..."}${a.reset}`);
          hud.update({ activeAgent: "PLN", activeAgentActivity: replanAttempts > 0 ? "replanning..." : "planning..." });

          const planAgent = spawnPlanAgentWithSkill();

          pteResult = await planThenExecute({
            sliceContent: slice.content,
            planAgent,
            tddAgent,
            brief: tddFirstMessage.value ? brief : "",
            makePlanStreamer: () => boundMakeStreamer(BOT_PLAN),
            makeExecuteStreamer: () => boundMakeStreamer(BOT_TDD),
            withInterrupt,
            isSkipped: () => sliceSkipFlag,
            isHardInterrupted: () => hardInterruptPending,
            onToolUse,
            log,
            noInteraction,
            askUser: noInteraction ? undefined : hud.askUser,
            onPlanReady: () => hud.update({ activeAgent: "PLN", activeAgentActivity: "plan ready" }),
          });
          replanAttempts++;
        } while (pteResult.replan && replanAttempts < MAX_REPLANS);

        // After max replans, auto-accept: re-run planThenExecute without askUser
        if (pteResult.replan) {
          log(`${ts()} ${a.yellow}Max replans reached — auto-accepting plan${a.reset}`);
          const planAgent = spawnPlanAgentWithSkill();
          pteResult = await planThenExecute({
            sliceContent: slice.content,
            planAgent,
            tddAgent,
            brief: tddFirstMessage.value ? brief : "",
            makePlanStreamer: () => boundMakeStreamer(BOT_PLAN),
            makeExecuteStreamer: () => boundMakeStreamer(BOT_TDD),
            withInterrupt,
            isSkipped: () => sliceSkipFlag,
            isHardInterrupted: () => hardInterruptPending,
            onToolUse,
            log,
            noInteraction: true,
          });
        }

        if (pteResult.skipped) {
          await doSkip();
          continue;
        }

        let tddResult = pteResult.tddResult;

        // Hard interrupt: agent was killed during plan or execute phase
        if (pteResult.hardInterrupt) {
          const guidance = pteResult.hardInterrupt;
          hardInterruptPending = null;
          log(`${ts()} ${a.yellow}⚡ Respawning TDD agent with guidance...${a.reset}`);
          tddAgent = await spawnTddAgent(tddSkill);
          tddFirstMessage.value = true;
          reviewFirstMessage.value = true;
          const s2 = boundMakeStreamer(BOT_TDD);
          tddResult = await withInterrupt(tddAgent, () =>
            tddAgent.send(withBrief(guidance, brief), s2, onToolUse),
          );
          s2.flush();
        }

        tddFirstMessage.value = false;
        await exitOnCreditExhaustion(tddResult, tddAgent);
        await followUpIfNeeded(
          tddResult,
          tddAgent,
          noInteraction,
          boundMakeStreamer,
          onToolUse,
          hud.askUser,
        );

        if (sliceSkipFlag) {
          await doSkip();
          continue;
        }

        if (tddResult.exitCode !== 0) {
          log(
            `\n${ts()} ${a.red}✗ TDD agent failed (exit ${tddResult.exitCode}) on Slice ${slice.number}. Continuing...${a.reset}`,
          );
          continue;
        }

        // ── Commit sweep — ensure TDD bot's work is committed ────────────
        syncToOrch();
        await _orch.commitSweep(`Slice ${slice.number}`);
        syncFromOrch();

        // ── Post-TDD pipeline: already-implemented → verify → review → summary ──
        syncToOrch();
        const prevCompleted = _orch.slicesCompleted;
        const sliceResult = await _orch.runSlice(slice, reviewBase, tddResult, verifyBaseSha);
        syncFromOrch();
        state = _orch.state;

        if (sliceResult.skipped) {
          await doSkip();
          continue;
        }

        reviewBase = sliceResult.reviewBase;
        const delta = _orch.slicesCompleted - prevCompleted;
        groupSlicesCompleted += delta;
        globalSlicesCompleted += delta;
        hud.update({
          completedSlices: globalSlicesCompleted,
          groupCompleted: groupSlicesCompleted,
        });
      }
    }

    // Reset skip visual but keep sliceSkipFlag alive for gap/commit phases
    hud.setSkipping(false);
    hud.setActivity("");

    // ── Gap analysis ──
    if (sliceSkipFlag) {
      log(`\n${ts()} ${a.yellow}⏭ Gap analysis skipped by operator${a.reset}`);
      sliceSkipFlag = false;
      hud.setSkipping(false);
    } else if (await hasChanges(cwd, groupBaseSha)) {
      log(
        `\n${ts()} ${BOT_GAP.badge} ${a.yellow}scanning for coverage gaps across group...${a.reset}`,
      );

      const groupContent = group.slices.map((s: Slice) => s.content).join("\n\n---\n\n");
      const gapAgent = spawnAgent(BOT_GAP);
      const gapPrompt = withBrief(buildGapPrompt(groupContent, groupBaseSha), brief);
      let s = boundMakeStreamer(BOT_GAP);
      const gapResult = await withInterrupt(gapAgent, () => gapAgent.send(gapPrompt, s, onToolUse));
      s.flush();
      await exitOnCreditExhaustion(gapResult, gapAgent);

      if (sliceSkipFlag) {
        log(`\n${ts()} ${a.yellow}⏭ Gap fixes skipped by operator${a.reset}`);
        sliceSkipFlag = false;
        hud.setSkipping(false);
      } else if (gapResult.exitCode !== 0) {
        log(
          `${ts()} ${a.yellow}⚠ Gap analysis agent failed (exit ${gapResult.exitCode}) — skipping${a.reset}`,
        );
      } else {
        const gapText = gapResult.assistantText;

        if (gapText && !gapText.includes("NO_GAPS_FOUND")) {
          log(`${ts()} ${BOT_GAP.badge} ${a.yellow}gaps found — sending to TDD bot${a.reset}`);

          if (sliceSkipFlag) {
            log(`${ts()} ${a.yellow}⏭ Gap fixes skipped by operator${a.reset}`);
            sliceSkipFlag = false;
            hud.setSkipping(false);
          } else {
            const gapBaseSha = await captureRef(cwd);
            const gapFixPrompt = buildTddPrompt(
              groupContent,
              `A gap analysis found missing test coverage. Add the missing tests.\n\n## Gaps Found\n${gapText}\n\nAdd tests for each gap. Do NOT refactor or change existing code — only add tests.`,
            );
            s = boundMakeStreamer(BOT_TDD);
            const gapFixResult = await withInterrupt(tddAgent, () =>
              tddAgent.send(
                tddFirstMessage.value ? withBrief(gapFixPrompt, brief) : gapFixPrompt,
                s,
                onToolUse,
              ),
            );
            s.flush();
            tddFirstMessage.value = false;
            await exitOnCreditExhaustion(gapFixResult, tddAgent);
            await followUpIfNeeded(
              gapFixResult,
              tddAgent,
              noInteraction,
              boundMakeStreamer,
              onToolUse,
              hud.askUser,
            );
            if (!(await hasChanges(cwd, gapBaseSha))) {
              log(`${ts()} ${a.dim}TDD bot made no changes for gaps${a.reset}`);
            } else {
              syncToOrch();
              await _orch.reviewFix(groupContent, gapBaseSha);
              syncFromOrch();
              log(`${ts()} ${a.green}✓ Gap tests added and reviewed${a.reset}`);
            }
          }
        } else {
          log(`${ts()} ${a.green}✓ No coverage gaps found${a.reset}`);
        }
      }

      gapAgent.kill();
    }

    // ── Commit sweep — catch uncommitted changes before marking group done ──
    if (sliceSkipFlag) {
      log(`\n${ts()} ${a.yellow}⏭ Commit sweep skipped by operator${a.reset}`);
      sliceSkipFlag = false;
      hud.setSkipping(false);
    }
    syncToOrch();
    await _orch.commitSweep(group.name);
    syncFromOrch();

    state = { ...state, lastCompletedGroup: group.name };
    await saveState(stateFile, state);
    sliceSkippable = false;
    sliceSkipFlag = false;
    hud.setSkipping(false);

    // ── Inter-group transition ──
    if (i < remaining.length - 1) {
      // Kill and respawn agents — clean context slate
      tddAgent.kill();
      reviewAgent.kill();
      tddAgent = await spawnTddAgent(tddSkill);
      reviewAgent = await spawnReviewAgent(reviewSkill);
      tddFirstMessage.value = true;
      reviewFirstMessage.value = true;

      const next = remaining[i + 1];
      const nextLabel = `${next.name} (${next.slices.map((s: Slice) => `Slice ${s.number}`).join(", ")})`;

      if (auto || noInteraction) {
        log(`\n${ts()} ${a.dim}→ next: ${nextLabel}${a.reset}`);
      } else {
        log(`\n${ts()} ${a.green}✓ Group "${group.name}" complete${a.reset}`);
        const answer = await hud.askUser(`Group done. Run ${nextLabel} next? (Y/n) `);
        if (answer.toLowerCase() === "n") {
          log(`Stopped. Resume with --group "${next.name}"`);
          cleanup();
          process.exit(0);
        }
      }
    }
  }

  // 11. Final review passes
  if (await hasChanges(cwd, runBaseSha)) {
    logSection(log, "Final review — 3 targeted passes");

    const passes = buildFinalPasses(runBaseSha, planContent);

    for (const pass of passes) {
      log(`\n${ts()} ${BOT_FINAL.badge} ${a.green}${pass.name}...${a.reset}`);

      // Fresh agent per final pass
      const finalAgent = spawnAgent(BOT_FINAL);
      const finalPrompt = withBrief(pass.prompt, brief);
      let s = boundMakeStreamer(BOT_FINAL);
      const finalResult = await withInterrupt(finalAgent, () =>
        finalAgent.send(finalPrompt, s, onToolUse),
      );
      s.flush();
      await exitOnCreditExhaustion(finalResult, finalAgent);
      finalAgent.kill();

      if (finalResult.exitCode !== 0) {
        log(`${ts()} ${a.dim}${pass.name}: agent failed — skipping${a.reset}`);
        continue;
      }

      const findings = finalResult.assistantText;

      if (!findings || findings.includes("NO_ISSUES_FOUND")) {
        log(`${ts()} ${a.green}✓ ${pass.name}: clean${a.reset}`);
        continue;
      }

      log(`${ts()} ${BOT_FINAL.badge} ${a.yellow}${pass.name}: issues found${a.reset}`);

      // Fix cycle for final pass findings
      log(`${ts()} ${BOT_TDD.badge} ${a.cyan}fixing ${pass.name} findings...${a.reset}`);

      const preFixSha = await captureRef(cwd);
      const fixPrompt = buildTddPrompt(
        planContent,
        `A final "${pass.name}" review found issues. Address them.\n\n## Findings\n${findings}`,
      );
      s = boundMakeStreamer(BOT_TDD);
      const fixResult = await withInterrupt(tddAgent, () =>
        tddAgent.send(
          tddFirstMessage.value ? withBrief(fixPrompt, brief) : fixPrompt,
          s,
          onToolUse,
        ),
      );
      s.flush();
      tddFirstMessage.value = false;
      await exitOnCreditExhaustion(fixResult, tddAgent);
      await followUpIfNeeded(
        fixResult,
        tddAgent,
        noInteraction,
        boundMakeStreamer,
        onToolUse,
        hud.askUser,
      );
      if (!(await hasChanges(cwd, preFixSha))) {
        log(`${ts()} ${a.dim}TDD bot made no changes for ${pass.name}${a.reset}`);
        continue;
      }

      // Review cycle on the fixes
      syncToOrch();
      await _orch.reviewFix(planContent, preFixSha);
      syncFromOrch();
      log(`${ts()} ${a.green}✓ ${pass.name}: resolved${a.reset}`);
    }
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
