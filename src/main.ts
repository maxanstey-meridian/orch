#!/usr/bin/env npx ts-node
/**
 * main.ts — TDD orchestrator CLI
 *
 * Wires tested leaf modules into a procedural pipeline.
 * No dep injection, no framework — reads top-to-bottom.
 *
 * Usage:
 *   npx ts-node src/main.ts --plan inventory.md              # generate plan from inventory
 *   npx ts-node src/main.ts --plan inventory.md --plan-only  # generate plan only, don't orchestrate
 *   npx ts-node src/main.ts --resume                          # resume last generated plan
 *   npx ts-node src/main.ts --resume plan.md                  # resume specific plan
 *   npx ts-node src/main.ts --resume --auto                   # no inter-group prompts
 *   npx ts-node src/main.ts --resume --group Auth             # start from group
 *   npx ts-node src/main.ts --resume --no-interaction         # suppress all prompts
 *   npx ts-node src/main.ts --resume --skip-fingerprint
 *   npx ts-node src/main.ts --resume --review-threshold 50
 *   npx ts-node src/main.ts --init --plan inventory.md        # interactive project init
 */

import { createHash } from "crypto";
import { resolve } from "path";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { readFile } from "fs/promises";
import { parsePlan, type Slice } from "./plan-parser.js";
import { generatePlan, isPlanFormat, planFileName, planIdFromPath } from "./plan-generator.js";
import { loadState, saveState, clearState, statePathForPlan, type OrchestratorState } from "./state.js";
import { runFingerprint, wrapBrief } from "./fingerprint.js";
import { runInit, profileToMarkdown, createAsk } from "./init.js";
import { createAgent, type AgentProcess, type AgentResult, type AgentStyle } from "./agent.js";
import { captureRef, hasChanges, getStatus, hasDirtyTree } from "./git.js";
import { assertGitRepo } from "./repo-check.js";
import { runTestGate } from "./test-gate.js";
import { isCleanReview } from "./review-check.js";

import { detectCreditExhaustion } from "./credit-detection.js";
import { measureDiff, shouldReview } from "./review-threshold.js";
// interrupt + skip + stdin-dispatcher replaced by HUD keyboard handling (ink useInput)
import { createHud, type WriteFn } from "./hud.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  maxReviewCycles: 3,
  stateFile: ".orchestrator-state.json",
  briefDir: ".orch",
};

// ─── ANSI ────────────────────────────────────────────────────────────────────

const a = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgMagenta: "\x1b[45m\x1b[30m",
  bgGreen: "\x1b[42m\x1b[30m",
};

const ts = (): string => {
  const d = new Date();
  return `${a.dim}${d.toLocaleTimeString("en-GB", { hour12: false })}${a.reset}`;
};

let log: (...args: unknown[]) => void = (...args: unknown[]) => console.log(...args);

const logSection = (title: string) => {
  const line = "━".repeat(64);
  log(`\n${a.bold}${a.white}${line}${a.reset}`);
  log(`${a.bold}  ${title}${a.reset}`);
  log(`${a.bold}${a.white}${line}${a.reset}`);
};

// ─── Bot styles ──────────────────────────────────────────────────────────────

const BOT_TDD: AgentStyle = { label: "TDD", color: a.cyan, badge: `${a.bgCyan} TDD ${a.reset}` };
const BOT_REVIEW: AgentStyle = {
  label: "REVIEW",
  color: a.magenta,
  badge: `${a.bgMagenta} REV ${a.reset}`,
};
const BOT_GAP: AgentStyle = {
  label: "GAP",
  color: a.yellow,
  badge: `${a.yellow}${a.bold} GAP ${a.reset}`,
};
const BOT_FINAL: AgentStyle = {
  label: "FINAL",
  color: a.green,
  badge: `${a.bgGreen} FIN ${a.reset}`,
};
const BOT_PLAN: AgentStyle = {
  label: "PLAN",
  color: a.white,
  badge: `${a.bold}${a.white} PLN ${a.reset}`,
};

// ─── Agent helpers ───────────────────────────────────────────────────────────

const BASE_FLAGS = ["--dangerously-skip-permissions"] as const;

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

// ─── Streaming formatter ─────────────────────────────────────────────────────

type Streamer = ((text: string) => void) & { flush: () => void };

const makeStreamer = (
  style: AgentStyle,
  writeFn: WriteFn = (t) => {
    process.stdout.write(t);
  },
): Streamer => {
  const gutter = `${style.color}│${a.reset} `;
  const wrapIndent = `${style.color}│${a.reset}   `;
  const maxWidth = (process.stdout.columns || 120) - 4;
  let atLineStart = true;
  let blankLines = 0;
  let col = 0;

  const highlight = (text: string): string =>
    text
      .replace(/\bRED\b/g, `${a.bold}${a.red}RED${a.reset}`)
      .replace(/\bGREEN\b/g, `${a.bold}${a.green}GREEN${a.reset}`)
      .replace(
        /\b([Cc]ommitted at|[Cc]ommit) `([a-f0-9]{7,40})`/g,
        `$1 ${a.bold}${a.yellow}\`$2\`${a.reset}`,
      );

  const write = (text: string) => {
    // Each assistant event is a full block — add separator if needed
    if (!atLineStart) {
      writeFn("\n");
      atLineStart = true;
      blankLines = 1;
    }
    if (blankLines < 2) {
      writeFn(`${gutter}\n`);
      blankLines++;
    }

    const formatted = highlight(text);
    const words = formatted.split(/(\s+)/);

    for (const word of words) {
      if (atLineStart) {
        writeFn(gutter);
        atLineStart = false;
        col = 0;
      }
      if (word === "\n") {
        writeFn("\n");
        atLineStart = true;
        blankLines++;
        col = 0;
      } else if (word.includes("\n")) {
        for (const ch of word) {
          if (atLineStart) {
            writeFn(gutter);
            atLineStart = false;
            col = 0;
          }
          writeFn(ch);
          if (ch === "\n") {
            atLineStart = true;
            blankLines++;
            col = 0;
          } else {
            blankLines = 0;
            col++;
          }
        }
      } else if (col + word.length > maxWidth && col > 0 && word.trim()) {
        writeFn("\n");
        writeFn(wrapIndent);
        writeFn(word);
        col = 2 + word.length;
        blankLines = 0;
      } else {
        writeFn(word);
        col += word.length;
        blankLines = 0;
      }
    }
  };

  write.flush = () => {
    if (!atLineStart) {
      writeFn("\n");
      atLineStart = true;
    }
  };

  return write;
};

// ─── Brief helper ────────────────────────────────────────────────────────────

const withBrief = (prompt: string, brief: string): string => {
  if (!brief) return prompt;
  return `${wrapBrief(brief)}\n\n${prompt}`;
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
  maxFollowUps = 3,
): Promise<AgentResult> => {
  let current = result;
  let followUps = 0;

  while (current.needsInput && !noInteraction && followUps < maxFollowUps) {
    log(`\n${ts()} ${a.yellow}Bot is asking for input ↑${a.reset}`);
    const answer = await ask(`${a.bold}Your response${a.reset} (or Enter to skip): `);

    const s = createStreamer(agent.style);
    if (!answer.trim()) {
      log(`${ts()} ${a.dim}skipped — telling bot to proceed autonomously${a.reset}`);
      current = await agent.send(
        "No preference — proceed with your best judgement. Make the decision yourself and continue implementing.",
        s,
      );
    } else {
      current = await agent.send(answer, s);
    }
    s.flush();
    followUps++;
  }

  return current;
};

// ─── Prompt builders ─────────────────────────────────────────────────────────

const buildTddPrompt = (sliceContent: string, fixInstructions?: string): string => {
  const integration = `## Integration
Before writing any code for this slice, read the existing codebase to understand how this capability is currently implemented (if at all). Check for existing utilities, scripts, patterns, and external files referenced in the plan or brief that should be reused. Your implementation must integrate with the real system, not exist in isolation.`;

  const autonomy = `## Autonomy
You are running inside an automated orchestrator. The plan slice is the spec — treat it as pre-approved.
Do NOT ask for confirmation on interface design, test strategy, or approach. Make your best judgement and proceed.
Only stop to ask if you are genuinely blocked — e.g. the plan is ambiguous in a way where the wrong choice would waste significant work, or you need information not available in the codebase. "Does this look right?" is not a valid reason to stop.`;

  if (fixInstructions) {
    return `A code review found issues with the current plan slice. Address them.

## Plan Slice
${sliceContent}

## Review Feedback
${fixInstructions}

${integration}

${autonomy}`;
  }

  return `Implement the following plan slice using strict RED→GREEN TDD cycles.

The plan slice contains numbered cycles with RED and GREEN blocks. Follow them in order:
1. Write the test described in RED. Run tests. Confirm it fails.
2. Write the minimal code described in GREEN. Run tests. Confirm it passes.
3. Move to the next cycle. Do NOT skip ahead or batch.

If the plan slice does not contain explicit cycles, decompose it into behaviours yourself and apply the same process: one failing test, then minimal code to pass, repeat.

## Plan Slice
${sliceContent}

${integration}

${autonomy}`;
};

export const buildCommitSweepPrompt = (groupName: string): string =>
  `There are uncommitted changes in the working tree. Review them, commit anything that belongs to the "${groupName}" group's work, and discard or stash anything that doesn't.

## Group
${groupName}

## Instructions
1. Run \`git status\` and \`git diff\` to see what changed.
2. Stage and commit files that belong to this group's work with a descriptive message.
3. Discard or stash anything unrelated.`;

type CommitSweepDeps = {
  groupName: string;
  cwd: string;
  agent: AgentProcess;
  makeStreamer: () => Streamer;
  exitOnCreditExhaustion: (result: AgentResult, agent: AgentProcess) => Promise<void>;
  withInterrupt: <T>(agent: AgentProcess, fn: () => Promise<T>) => Promise<T>;
  hasDirtyTree: (cwd: string) => Promise<boolean>;
  log: (...args: unknown[]) => void;
  followUpIfNeeded?: (result: AgentResult, agent: AgentProcess) => Promise<AgentResult>;
};

export const commitSweep = async (deps: CommitSweepDeps): Promise<void> => {
  const dirty = await deps.hasDirtyTree(deps.cwd);
  if (!dirty) return;

  if (!deps.agent.alive) {
    deps.log(`${ts()} ${a.yellow}⚠ TDD agent not alive — skipping commit sweep${a.reset}`);
    return;
  }

  deps.log(`${ts()} ${BOT_TDD.badge} uncommitted changes detected — asking TDD bot to commit`);
  const prompt = buildCommitSweepPrompt(deps.groupName);
  const s = deps.makeStreamer();
  const result = await deps.withInterrupt(deps.agent, () => deps.agent.send(prompt, s));
  s.flush();
  await deps.exitOnCreditExhaustion(result, deps.agent);
  if (deps.followUpIfNeeded && result.needsInput) {
    await deps.followUpIfNeeded(result, deps.agent);
  }

  if (result.exitCode === 0) {
    deps.log(`${ts()} ${a.green}✓ commit sweep complete${a.reset}`);
  } else {
    deps.log(
      `${ts()} ${a.yellow}⚠ commit sweep agent failed (exit ${result.exitCode}) — uncommitted changes may remain${a.reset}`,
    );
  }
};

const buildReviewPreamble = (baseSha: string): string =>
  `## How to review

1. Run \`git diff --name-only ${baseSha}..HEAD\` to identify changed files.
2. **Read the full contents of every changed file** — do not just read diffs. Diffs hide context: you miss dead code outside the hunk, broken invariants in unchanged branches, and type mismatches at boundaries the diff doesn't show.
3. For each changed file, identify files that import from or call into it. Read those too if a boundary changed.
4. **Verify every finding against the current file state before reporting.** If you see something in the diff that looks wrong, open the file and confirm it's still wrong. Do not report stale findings from a previous cycle.

## Review discipline

- **Two-pass priority.** Data safety, race conditions, and bugs first. Structural and naming issues second. Do not interleave severities.
- **No hedging.** Not "you might want to", not "it could be worth considering". State what's wrong and what the fix is.
- **No praise sandwiches.** Code that works correctly is baseline — not noteworthy. Do not pad findings with compliments.
- **Severity is not negotiable.** A bug is a bug. A type lie is a type lie. Do not downgrade to be diplomatic.

## Output format

For each finding:
- **File and line**
- **What's wrong** (one sentence)
- **Evidence** (the code or trace that proves it)
- **Fix** (concrete, actionable)

## Deliverable check

Before concluding, answer this: if a project manager read the plan slice and then looked at what was built, would they consider it actually done? Specifically:
- If new infrastructure replaces old, are ALL old consumers migrated? Search for remaining references to the old code/path/function.
- Is the new code actually reachable? Trace from the entry point to confirm it runs.
- Are there orphaned setup steps (directories created, config added, types defined) that nothing actually uses?
A feature that exists but isn't wired in is not delivered.`;

const buildReviewPrompt = (sliceContent: string, baseSha: string): string =>
  `Review the changes since commit ${baseSha} against the intended plan slice.

${buildReviewPreamble(baseSha)}

## What to look for
- Bugs: incorrect runtime behavior, off-by-one, swallowed errors, race conditions
- Type fidelity: runtime values disagreeing with declared types, \`any\`/\`unknown\` as value carriers
- Dead code: new exports with zero consumers introduced by the change
- Structural: duplicated logic, parallel state, mixed concerns introduced by the change
- Names: identifiers that no longer match their scope or purpose after the change
- Enum/value completeness: new variants not handled in all consumers

## What NOT to flag
- Style, formatting, cosmetic preferences
- Test coverage gaps (separate pass handles this)
- Harmless redundancy that aids readability
- Threshold values tuned empirically

## Intended Plan Slice
${sliceContent}

If all changes are correct, respond with exactly: REVIEW_CLEAN`;

const buildGapPrompt = (groupContent: string, baseSha: string): string =>
  `You are a gap-finder for a TDD pipeline. A group of slices has just been implemented and reviewed.

Your job is to find **missing test coverage and unhandled edge cases** — NOT code style, naming, or architecture.

${buildReviewPreamble(baseSha)}

## What to look for
- Untested edge cases and boundary conditions
- Combinations of features built in this group that have no test coverage
  (e.g. arrays of enums, nullable records, nested compositions)
- Integration paths between slices with no coverage
- Off-by-one scenarios, empty inputs, null inputs
- Any behaviour described in the plan that has no corresponding test

## What NOT to report
- Code style, formatting, naming — already reviewed
- Architecture suggestions, refactoring ideas — not your job
- Things that are tested adequately — no praise needed

## Group plan
${groupContent}

If you find gaps, list each one as:
- **Gap:** <what's missing>
- **Suggested test:** <one-line description of the test to add>

If everything is well covered, respond with exactly: NO_GAPS_FOUND`;

const buildFinalPasses = (
  baseSha: string,
  planContent: string,
): { name: string; prompt: string }[] => [
  {
    name: "Type fidelity",
    prompt: `You are auditing type safety across all changes since commit ${baseSha}.

${buildReviewPreamble(baseSha)}

## What to look for
- \`object\` or \`object?\` used as a value carrier (not as a constraint)
- \`dynamic\` anywhere
- \`as any\`, \`as unknown\`, or unchecked casts that bypass the type system
- Non-null assertions (\`!\`) used for convenience rather than proven invariants
- \`Dictionary<string, object>\` or untyped dictionaries where keys are known
- Missing nullability — value types that should be nullable but aren't (or vice versa)
- \`var\` hiding a type that should be explicit for clarity

If everything is clean, respond with exactly: NO_ISSUES_FOUND`,
  },
  {
    name: "Plan completeness",
    prompt: `You are verifying that the implementation matches the plan.

${buildReviewPreamble(baseSha)}

## Plan
${planContent}

For each item in the plan, verify:
1. Was it implemented?
2. Were the specified edge cases handled?
3. Is there a test for each specified behaviour?

Report:
- **Missing:** features/behaviours in the plan with no implementation
- **Untested:** features that exist but have no test coverage
- **Divergent:** implementations that differ from the plan (may be fine — flag for review)

If everything matches, respond with exactly: NO_ISSUES_FOUND`,
  },
  {
    name: "Cross-cutting integration",
    prompt: `You are reviewing cross-component integration across all changes since commit ${baseSha}.

${buildReviewPreamble(baseSha)}

## What to look for
- Do output types from one component match input types expected by the next?
- Are discriminated union variants handled exhaustively in every switch/pattern match?
- Are there any type variants added in one file but not handled in consumers?
- Do error paths propagate correctly (warnings emitted, not swallowed)?
- Are there any unused registrations (types registered but never referenced)?
- Do shared function signatures stay consistent across files? (e.g. parameter ordering)

If everything integrates cleanly, respond with exactly: NO_ISSUES_FOUND`,
  },
];

// ─── Terminal output ─────────────────────────────────────────────────────────

const printSliceIntro = (slice: Slice) => {
  log(`\n${a.bold}${a.white}┌─ Slice ${slice.number}: ${slice.title}${a.reset}`);
  const introLine = slice.content
    .split("\n")
    .find((l: string) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  if (introLine) log(`${a.dim}│  ${introLine.trim()}${a.reset}`);
  log(`${a.dim}└──${a.reset}\n`);
};

const printSliceSummary = (sliceNumber: number, summary: string) => {
  if (!summary.trim()) return;
  log("");
  log(`${a.bold}${a.green}┌─ Slice ${sliceNumber} complete ────────────────────────────${a.reset}`);
  for (const line of summary.trim().split("\n")) {
    const formatted = line
      .replace(/^## (.+)/, `${a.bold}${a.white}│ $1${a.reset}`)
      .replace(/^- (.+)/, `${a.dim}│${a.reset}  - $1`)
      .replace(/^(?!│)(.+)/, `${a.dim}│${a.reset}  $1`);
    log(formatted);
  }
  log(`${a.bold}${a.green}└──────────────────────────────────────────────${a.reset}`);
};

// ─── Review-fix loop ─────────────────────────────────────────────────────────

const reviewFixLoop = async (
  tddAgent: AgentProcess,
  reviewAgent: AgentProcess,
  content: string,
  brief: string,
  cwd: string,
  noInteraction: boolean,
  tddFirstMessage: { value: boolean },
  reviewFirstMessage: { value: boolean },
  testCommand: string | undefined,
  exitOnCreditExhaustion: (result: AgentResult, agent: AgentProcess) => Promise<void>,
  withInterrupt: <T>(agent: AgentProcess, fn: () => Promise<T>) => Promise<T>,
  createStreamer: (style: AgentStyle) => Streamer,
  baseSha?: string,
  onStatusChange?: (agent: string, activity: string) => void,
  shouldSkip?: () => boolean,
): Promise<void> => {
  let reviewSha = baseSha ?? (await captureRef(cwd));

  for (let cycle = 1; cycle <= CONFIG.maxReviewCycles; cycle++) {
    if (shouldSkip?.()) break;

    log(
      `\n${ts()} ${BOT_REVIEW.badge} ${a.magenta}review cycle ${cycle}/${CONFIG.maxReviewCycles}${a.reset}`,
    );

    if (!(await hasChanges(cwd, reviewSha))) {
      log(`${ts()} ${a.dim}no diff — skipping review${a.reset}`);
      break;
    }

    onStatusChange?.("REV", `reviewing (cycle ${cycle})...`);
    const reviewPrompt = reviewFirstMessage.value
      ? withBrief(buildReviewPrompt(content, reviewSha), brief)
      : buildReviewPrompt(content, reviewSha);
    let s = createStreamer(BOT_REVIEW);
    const reviewResult = await withInterrupt(reviewAgent, () => reviewAgent.send(reviewPrompt, s));
    s.flush();
    await exitOnCreditExhaustion(reviewResult, reviewAgent);
    reviewFirstMessage.value = false;
    const reviewText = reviewResult.assistantText;

    if (!reviewText || isCleanReview(reviewText)) {
      log(`${ts()} ${a.green}✓ Review clean — no findings.${a.reset}`);
      break;
    }

    onStatusChange?.("TDD", "fixing review feedback...");
    log(`${ts()} ${BOT_TDD.badge} ${a.cyan}fixing review feedback...${a.reset}`);
    const preFixSha = await captureRef(cwd);
    const fixPrompt = buildTddPrompt(content, reviewText);
    s = createStreamer(BOT_TDD);
    const fixResult = await withInterrupt(tddAgent, () =>
      tddAgent.send(tddFirstMessage.value ? withBrief(fixPrompt, brief) : fixPrompt, s),
    );
    s.flush();
    tddFirstMessage.value = false;
    await followUpIfNeeded(fixResult, tddAgent, noInteraction, createStreamer);

    if (!(await hasChanges(cwd, preFixSha))) {
      log(`${ts()} ${a.dim}TDD bot made no changes — review cycle complete${a.reset}`);
      break;
    }

    const testResult = await runTestGate({ testCommand });
    if (!testResult.passed) {
      log(
        `${ts()} ${a.yellow}⚠ Tests failed after review fix cycle ${cycle}. Continuing...${a.reset}`,
      );
    }

    // Advance review base so next cycle only reviews the fix delta, not the entire original diff
    reviewSha = await captureRef(cwd);
  }
};

// ─── Plan generation helper ──────────────────────────────────────────────────

const doGeneratePlan = async (
  inventoryPath: string,
  briefContent: string,
  outputDir: string,
  globalStatePath: string,
  currentGlobalState: OrchestratorState,
): Promise<string> => {
  log(`${a.bold}Generating plan from inventory...${a.reset}`);
  const planAgent = spawnAgent(BOT_PLAN);
  try {
    const { planPath, planId } = await generatePlan(inventoryPath, briefContent, planAgent, outputDir, inventoryPath);
    log(`${a.green}Plan written to ${planPath}${a.reset}`);
    // Persist planId to global state so --resume can find it
    await saveState(globalStatePath, { ...currentGlobalState, currentPlanId: planId });
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
  const resumeMode = args.includes("--resume");
  // --resume takes an optional path; only consume next arg if it's not another flag
  const resumeIdx = args.indexOf("--resume");
  const resumeNext = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;
  const resumeRaw = resumeNext && !resumeNext.startsWith("-") ? resumeNext : undefined;
  const planOnly = args.includes("--plan-only");
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
  if (!inventoryPath && !resumeMode) {
    console.error(
      "Provide --plan <inventory> to generate a plan, or --resume to continue an existing one.",
    );
    process.exit(1);
  }

  // 1. Load skill prompts
  const skillsDir = resolve(import.meta.dirname, "..", "skills");
  const tddSkill = readFileSync(resolve(skillsDir, "tdd.md"), "utf-8");
  const reviewSkill = readFileSync(resolve(skillsDir, "deep-review.md"), "utf-8");

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

  const { brief, profile } = await runFingerprint({
    cwd,
    outputDir: orchDir,
    skip: skipFingerprint,
    forceRefresh: !skipFingerprint,
  });

  // 3. Load global state — needed for plan resolution (currentPlanId)
  const globalStateFile = resolve(cwd, CONFIG.stateFile);
  const globalState = await loadState(globalStateFile);

  // Helper: resolve plan path from currentPlanId in global state
  const statePlanPath = globalState.currentPlanId
    ? resolve(orchDir, planFileName(globalState.currentPlanId))
    : undefined;

  // 4. Resolve plan path — generate from inventory or resume existing
  //    (uses currentPlanId from state loaded in step 3)
  let planPath: string;

  if (resumeMode) {
    // --resume [path]: use explicit path, or find existing plan
    if (resumeRaw) {
      planPath = resolve(resumeRaw);
    } else if (statePlanPath && existsSync(statePlanPath)) {
      planPath = statePlanPath;
    } else if (existsSync(resolve(cwd, "plan.md"))) {
      planPath = resolve(cwd, "plan.md");
    } else {
      console.error("No plan found. Use --plan <inventory> to generate one.");
      process.exit(1);
    }
  } else {
    // --plan <input>: generate plan from inventory (or detect it's already a plan)
    const inputPath = resolve(inventoryPath!);
    const srcContent = readFileSync(inputPath, "utf-8");

    if (isPlanFormat(srcContent)) {
      // Already a plan — treat as resume
      log(`${a.dim}Input is already a plan — treating as resume.${a.reset}`);
      planPath = inputPath;
    } else {
      // Check if a generated plan already exists (via state or legacy path)
      if (statePlanPath && existsSync(statePlanPath)) {
        if (noInteraction) {
          log(`${a.dim}Using existing plan (--no-interaction).${a.reset}`);
          planPath = statePlanPath;
        } else {
          const answer = await ask("A generated plan already exists. Regenerate? (y/N) ");
          if (answer.trim().toLowerCase() !== "y") {
            log(`${a.dim}Using existing plan.${a.reset}`);
            planPath = statePlanPath;
          } else {
            planPath = await doGeneratePlan(inputPath, brief, orchDir, globalStateFile, globalState);
          }
        }
      } else {
        planPath = await doGeneratePlan(inputPath, brief, orchDir, globalStateFile, globalState);
      }
    }
  }

  // 4b. Derive per-plan state path from resolved planPath
  let activePlanId: string;
  try {
    activePlanId = planIdFromPath(planPath);
  } catch {
    // External plan file (e.g. plan.md) — derive stable ID from path hash or global state
    activePlanId = globalState.currentPlanId
      ?? createHash("sha256").update(planPath).digest("hex").slice(0, 6);
  }
  const stateFile = statePathForPlan(orchDir, activePlanId);
  mkdirSync(resolve(orchDir, "state"), { recursive: true });

  // 4c. --reset clears the per-plan state file (not the global pointer)
  if (resetState) {
    await clearState(stateFile);
    log(`${a.dim}State cleared.${a.reset}`);
  }

  if (planOnly) {
    if (_rl) _rl.close();
    // Flush buffered output + final message directly (no HUD in this path)
    for (const line of earlyLog) origLog(line);
    origLog(`Plan written to ${planPath} — review and run with --resume`);
    process.exit(0);
  }

  // 4. Parse plan
  const groups = await parsePlan(planPath);

  // 4b. HUD — persistent status bar at bottom of terminal
  const totalSlices = groups.reduce((n, g) => n + g.slices.length, 0);
  const isTTY = process.stdout.isTTY === true;
  const hud = createHud(isTTY);
  let globalSlicesCompleted = 0;
  hud.update({ totalSlices, completedSlices: 0, startTime: Date.now() });
  log = hud.wrapLog(origLog);
  // Replay buffered pre-ink output through ink so it knows about those lines
  for (const line of earlyLog) log(line);
  const hudWriter = hud.createWriter();
  const boundMakeStreamer = (style: AgentStyle): Streamer => makeStreamer(style, hudWriter);

  // 5. Load per-plan state
  let state: OrchestratorState = await loadState(stateFile);

  // 6. Spawn persistent agents with skill system prompts
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
    `   ${a.dim}Tests${a.reset}   ${profile.testCommand ? `${a.green}✓${a.reset} ${profile.testCommand}` : `${a.yellow}⚠ none detected${a.reset}`}`,
  );
  log(
    `   ${a.dim}Mode${a.reset}    ${groupFilter ? `start from "${groupFilter}"` : auto ? "automatic" : "interactive"}`,
  );
  log(`   ${BOT_TDD.badge} ${a.dim}persistent (${tddAgent.sessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_REVIEW.badge} ${a.dim}persistent (${reviewAgent.sessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_GAP.badge} ${a.dim}fresh each group${a.reset}`);
  if (interactive)
    log(`   ${a.dim}Press${a.reset} ${a.bold}S${a.reset} ${a.dim}to skip current slice${a.reset}`);

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

  const runBaseSha = await captureRef(cwd);
  const planContent = await readFile(planPath, "utf-8");

  // 10. Group loop
  for (let i = 0; i < remaining.length; i++) {
    const group = remaining[i];

    logSection(
      `Group: ${group.name} — ${group.slices.map((s: Slice) => `Slice ${s.number}`).join(", ")}`,
    );
    hud.update({
      groupName: group.name,
      groupSliceCount: group.slices.length,
      groupCompleted: 0,
    });

    const groupBaseSha = await captureRef(cwd);

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

      printSliceIntro(slice);
      hud.update({
        currentSlice: { number: slice.number },
        activeAgent: "TDD",
        activeAgentActivity: "implementing...",
      });

      // Skip signal — active for the entire slice, not just TDD.
      // Pressing S toggles skip; checked after each async operation.
      sliceSkippable = true;
      sliceSkipFlag = false;

      const doSkip = async () => {
        sliceSkippable = false;
        sliceSkipFlag = false;
        hud.setSkipping(false);
        log(`\n${ts()} ${a.yellow}⏭ Slice ${slice.number} skipped by operator${a.reset}`);
        tddAgent.kill();
        tddAgent = spawnAgent(BOT_TDD, tddSkill);
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
        log(
          `${ts()} ${a.dim}⏩ TDD already ran for Slice ${slice.number} — resuming review${a.reset}`,
        );
      } else {
        log(`${ts()} ${BOT_TDD.badge} ${a.cyan}implementing...${a.reset}`);

        const tddPrompt = buildTddPrompt(slice.content);
        const prompt = tddFirstMessage.value ? withBrief(tddPrompt, brief) : tddPrompt;
        const s = boundMakeStreamer(BOT_TDD);

        let tddResult = await withInterrupt(tddAgent, () => tddAgent.send(prompt, s));
        s.flush();

        if (sliceSkipFlag) {
          await doSkip();
          continue;
        }

        // Hard interrupt: agent was killed, respawn and send the guidance
        if (hardInterruptPending) {
          const guidance = hardInterruptPending;
          hardInterruptPending = null;
          log(`${ts()} ${a.yellow}⚡ Respawning TDD agent with guidance...${a.reset}`);
          tddAgent = spawnAgent(BOT_TDD, tddSkill);
          tddFirstMessage.value = true;
          reviewFirstMessage.value = true;
          const s2 = boundMakeStreamer(BOT_TDD);
          tddResult = await withInterrupt(tddAgent, () =>
            tddAgent.send(withBrief(guidance, brief), s2),
          );
          s2.flush();
        }

        tddFirstMessage.value = false;
        await exitOnCreditExhaustion(tddResult, tddAgent);
        await followUpIfNeeded(tddResult, tddAgent, noInteraction, boundMakeStreamer);

        if (sliceSkipFlag) { await doSkip(); continue; }

        if (tddResult.exitCode !== 0) {
          log(
            `\n${ts()} ${a.red}✗ TDD agent failed (exit ${tddResult.exitCode}) on Slice ${slice.number}. Continuing...${a.reset}`,
          );
          continue;
        }

        // Test gate
        const testResult = await runTestGate({ testCommand: profile.testCommand });
        if (!testResult.passed) {
          log(
            `${ts()} ${a.red}✗ Tests failed after TDD agent on Slice ${slice.number}. Continuing...${a.reset}`,
          );
          continue;
        }

        if (sliceSkipFlag) { await doSkip(); continue; }

        state = { ...state, lastSliceImplemented: slice.number };
        await saveState(stateFile, state);
      }

      // Review-fix loop — gated on minimum diff threshold
      const diffStats = await measureDiff(cwd, reviewBase);
      if (!shouldReview(diffStats, reviewThreshold)) {
        log(
          `${ts()} ${a.dim}Diff too small (${diffStats.total} lines) — deferring review${a.reset}`,
        );
        // Don't advance reviewBase — let changes accumulate
        state = { ...state, lastCompletedSlice: slice.number };
        await saveState(stateFile, state);
        groupSlicesCompleted++;
        globalSlicesCompleted++;
        hud.update({
          completedSlices: globalSlicesCompleted,
          groupCompleted: groupSlicesCompleted,
        });
        continue; // skip to next slice
      }

      if (sliceSkipFlag) {
        await doSkip();
        continue;
      }

      hud.update({ activeAgent: "REV", activeAgentActivity: "reviewing..." });
      await reviewFixLoop(
        tddAgent,
        reviewAgent,
        slice.content,
        brief,
        cwd,
        noInteraction,
        tddFirstMessage,
        reviewFirstMessage,
        profile.testCommand,
        exitOnCreditExhaustion,
        withInterrupt,
        boundMakeStreamer,
        reviewBase,
        (agent, activity) => hud.update({ activeAgent: agent, activeAgentActivity: activity }),
        () => sliceSkipFlag,
      );
      reviewBase = await captureRef(cwd);
      if (sliceSkipFlag) {
        await doSkip();
        continue;
      }

      // Slice outro — summary via quiet mode
      log(`\n${ts()} ${a.dim}extracting slice summary...${a.reset}`);
      const summary = await tddAgent.sendQuiet(
        `Summarise what you just built for Slice ${slice.number} in this format exactly:

## What was built
<1-2 sentences: what capability now exists that didn't before>

## Key decisions
<2-4 bullet points: technical choices, edge cases handled, anything non-obvious>

## Files touched
<bulleted list of files created or modified>

## Test coverage
<1-2 sentences: what's tested, any known gaps>

Be concrete and specific. No filler.`,
      );
      printSliceSummary(slice.number, summary);

      state = { ...state, lastCompletedSlice: slice.number };
      await saveState(stateFile, state);
      groupSlicesCompleted++;
      globalSlicesCompleted++;
      hud.update({
        completedSlices: globalSlicesCompleted,
        groupCompleted: groupSlicesCompleted,
        activeAgent: undefined,
        activeAgentActivity: undefined,
      });
      sliceSkippable = false;
    }

    // ── Gap analysis ──
    if (await hasChanges(cwd, groupBaseSha)) {
      log(
        `\n${ts()} ${BOT_GAP.badge} ${a.yellow}scanning for coverage gaps across group...${a.reset}`,
      );

      const groupContent = group.slices.map((s: Slice) => s.content).join("\n\n---\n\n");
      const gapAgent = spawnAgent(BOT_GAP);
      const gapPrompt = withBrief(buildGapPrompt(groupContent, groupBaseSha), brief);
      let s = boundMakeStreamer(BOT_GAP);
      const gapResult = await withInterrupt(gapAgent, () => gapAgent.send(gapPrompt, s));
      s.flush();
      await exitOnCreditExhaustion(gapResult, gapAgent);

      if (gapResult.exitCode !== 0) {
        log(
          `${ts()} ${a.yellow}⚠ Gap analysis agent failed (exit ${gapResult.exitCode}) — skipping${a.reset}`,
        );
      } else {
        const gapText = gapResult.assistantText;

        if (gapText && !gapText.includes("NO_GAPS_FOUND")) {
          log(`${ts()} ${BOT_GAP.badge} ${a.yellow}gaps found — sending to TDD bot${a.reset}`);

          const gapBaseSha = await captureRef(cwd);
          const gapFixPrompt = buildTddPrompt(
            groupContent,
            `A gap analysis found missing test coverage. Add the missing tests.\n\n## Gaps Found\n${gapText}\n\nAdd tests for each gap. Do NOT refactor or change existing code — only add tests.`,
          );
          s = boundMakeStreamer(BOT_TDD);
          const gapFixResult = await withInterrupt(tddAgent, () =>
            tddAgent.send(tddFirstMessage.value ? withBrief(gapFixPrompt, brief) : gapFixPrompt, s),
          );
          s.flush();
          tddFirstMessage.value = false;
          await exitOnCreditExhaustion(gapFixResult, tddAgent);
          await followUpIfNeeded(gapFixResult, tddAgent, noInteraction, boundMakeStreamer);
          if (!(await hasChanges(cwd, gapBaseSha))) {
            log(`${ts()} ${a.dim}TDD bot made no changes for gaps${a.reset}`);
          } else {
            const testResult = await runTestGate({ testCommand: profile.testCommand });
            if (!testResult.passed) {
              log(`${ts()} ${a.yellow}⚠ Tests failed after gap fixes${a.reset}`);
            } else {
              await reviewFixLoop(
                tddAgent,
                reviewAgent,
                groupContent,
                brief,
                cwd,
                noInteraction,
                tddFirstMessage,
                reviewFirstMessage,
                profile.testCommand,
                exitOnCreditExhaustion,
                withInterrupt,
                boundMakeStreamer,
                gapBaseSha,
                (agent, activity) => hud.update({ activeAgent: agent, activeAgentActivity: activity }),
                () => sliceSkipFlag,
              );
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
    await commitSweep({
      groupName: group.name,
      cwd,
      agent: tddAgent,
      makeStreamer: () => boundMakeStreamer(BOT_TDD),
      exitOnCreditExhaustion,
      withInterrupt,
      hasDirtyTree,
      log,
      followUpIfNeeded: (result, agent) =>
        followUpIfNeeded(result, agent, noInteraction, boundMakeStreamer),
    });

    state = { ...state, lastCompletedGroup: group.name };
    await saveState(stateFile, state);

    // ── Inter-group transition ──
    if (i < remaining.length - 1) {
      // Kill and respawn agents — clean context slate
      tddAgent.kill();
      reviewAgent.kill();
      tddAgent = spawnAgent(BOT_TDD, tddSkill);
      reviewAgent = spawnAgent(BOT_REVIEW, reviewSkill);
      tddFirstMessage.value = true;
      reviewFirstMessage.value = true;

      const next = remaining[i + 1];
      const nextLabel = `${next.name} (${next.slices.map((s: Slice) => `Slice ${s.number}`).join(", ")})`;

      if (auto || noInteraction) {
        log(`\n${ts()} ${a.dim}→ next: ${nextLabel}${a.reset}`);
      } else {
        const answer = await ask(
          `\n${ts()} Group done. Run ${a.bold}${nextLabel}${a.reset} next? (Y/n) `,
        );
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
    logSection("Final review — 3 targeted passes");

    const passes = buildFinalPasses(runBaseSha, planContent);

    for (const pass of passes) {
      log(`\n${ts()} ${BOT_FINAL.badge} ${a.green}${pass.name}...${a.reset}`);

      // Fresh agent per final pass
      const finalAgent = spawnAgent(BOT_FINAL);
      const finalPrompt = withBrief(pass.prompt, brief);
      let s = boundMakeStreamer(BOT_FINAL);
      const finalResult = await withInterrupt(finalAgent, () => finalAgent.send(finalPrompt, s));
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
        tddAgent.send(tddFirstMessage.value ? withBrief(fixPrompt, brief) : fixPrompt, s),
      );
      s.flush();
      tddFirstMessage.value = false;
      await exitOnCreditExhaustion(fixResult, tddAgent);
      await followUpIfNeeded(fixResult, tddAgent, noInteraction, boundMakeStreamer);
      if (!(await hasChanges(cwd, preFixSha))) {
        log(`${ts()} ${a.dim}TDD bot made no changes for ${pass.name}${a.reset}`);
        continue;
      }

      const testResult = await runTestGate({ testCommand: profile.testCommand });
      if (!testResult.passed) {
        log(
          `${ts()} ${a.yellow}⚠ Tests failed after ${pass.name} fixes — continuing with next pass${a.reset}`,
        );
        continue;
      }

      // Review cycle on the fixes
      await reviewFixLoop(
        tddAgent,
        reviewAgent,
        planContent,
        brief,
        cwd,
        noInteraction,
        tddFirstMessage,
        reviewFirstMessage,
        profile.testCommand,
        exitOnCreditExhaustion,
        withInterrupt,
        boundMakeStreamer,
        preFixSha,
        (agent, activity) => hud.update({ activeAgent: agent, activeAgentActivity: activity }),
      );
      log(`${ts()} ${a.green}✓ ${pass.name}: resolved${a.reset}`);
    }
  }

  // 12. Cleanup
  logSection(`${a.green}✅ All groups complete + final review done${a.reset}`);
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
