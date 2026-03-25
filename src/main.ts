#!/usr/bin/env npx ts-node
/**
 * main.ts — TDD orchestrator CLI
 *
 * Wires tested leaf modules into a procedural pipeline.
 * No dep injection, no framework — reads top-to-bottom.
 *
 * Usage:
 *   npx ts-node src/main.ts --plan plan.md                  # interactive
 *   npx ts-node src/main.ts --plan plan.md --auto            # no inter-group prompts
 *   npx ts-node src/main.ts --plan plan.md --group Auth      # start from group
 *   npx ts-node src/main.ts --plan plan.md --no-interaction  # suppress all prompts
 *   npx ts-node src/main.ts --plan plan.md --skip-fingerprint
 *   npx ts-node src/main.ts --plan plan.md --review-threshold 50
 */

import { resolve } from "path";
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { createInterface } from "readline";
import { parsePlan, type Group, type Slice } from "./plan-parser.js";
import { loadState, saveState, clearState, type OrchestratorState } from "./state.js";
import { runFingerprint, wrapBrief } from "./fingerprint.js";
import { createAgent, type AgentProcess, type AgentResult, type AgentStyle } from "./agent.js";
import { captureRef, hasChanges, getStatus } from "./git.js";
import { assertGitRepo } from "./repo-check.js";
import { runTestGate } from "./test-gate.js";
import { isCleanReview } from "./review-check.js";

import { detectCreditExhaustion } from "./credit-detection.js";
import { measureDiff, shouldReview } from "./review-threshold.js";

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

const log = (msg: string) => console.log(msg);

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

const makeStreamer = (style: AgentStyle): Streamer => {
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
      process.stdout.write("\n");
      atLineStart = true;
      blankLines = 1;
    }
    if (blankLines < 2) {
      process.stdout.write(`${gutter}\n`);
      blankLines++;
    }

    const formatted = highlight(text);
    const words = formatted.split(/(\s+)/);

    for (const word of words) {
      if (atLineStart) {
        process.stdout.write(gutter);
        atLineStart = false;
        col = 0;
      }
      if (word === "\n") {
        process.stdout.write("\n");
        atLineStart = true;
        blankLines++;
        col = 0;
      } else if (word.includes("\n")) {
        for (const ch of word) {
          if (atLineStart) {
            process.stdout.write(gutter);
            atLineStart = false;
            col = 0;
          }
          process.stdout.write(ch);
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
        process.stdout.write("\n");
        process.stdout.write(wrapIndent);
        process.stdout.write(word);
        col = 2 + word.length;
        blankLines = 0;
      } else {
        process.stdout.write(word);
        col += word.length;
        blankLines = 0;
      }
    }
  };

  write.flush = () => {
    if (!atLineStart) {
      process.stdout.write("\n");
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

const ask = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
};

// ─── Interactive follow-up ───────────────────────────────────────────────────

const followUpIfNeeded = async (
  result: AgentResult,
  agent: AgentProcess,
  noInteraction: boolean,
  maxFollowUps = 3,
): Promise<AgentResult> => {
  let current = result;
  let followUps = 0;

  while (current.needsInput && !noInteraction && followUps < maxFollowUps) {
    log(`\n${ts()} ${a.yellow}Bot is asking for input ↑${a.reset}`);
    const answer = await ask(`${a.bold}Your response${a.reset} (or Enter to skip): `);

    const s = makeStreamer(agent.style);
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

  return `Implement the following plan slice.

## Plan Slice
${sliceContent}

${integration}

${autonomy}`;
};

const buildReviewPrompt = (sliceContent: string, baseSha: string): string =>
  `Review the changes since commit ${baseSha} against the intended plan slice.

## Intended Plan Slice
${sliceContent}`;

const buildGapPrompt = (groupContent: string, baseSha: string): string =>
  `You are a gap-finder for a TDD pipeline. A group of slices has just been implemented and reviewed.

Your job is to find **missing test coverage and unhandled edge cases** — NOT code style, naming, or architecture.

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

## Changes to review
All commits since ${baseSha}. Use \`git log ${baseSha}..HEAD --oneline\` and \`git diff ${baseSha}..HEAD\` to see what was built, then read the test files to find gaps.

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

Search for and report ANY of these violations:
- \`object\` or \`object?\` used as a value carrier (not as a constraint)
- \`dynamic\` anywhere
- \`as any\`, \`as unknown\`, or unchecked casts that bypass the type system
- Non-null assertions (\`!\`) used for convenience rather than proven invariants
- \`Dictionary<string, object>\` or untyped dictionaries where keys are known
- Missing nullability — value types that should be nullable but aren't (or vice versa)
- \`var\` hiding a type that should be explicit for clarity

For each finding report:
- **File:** path and line
- **Issue:** what's wrong
- **Fix:** what the type should be

If everything is clean, respond with exactly: NO_ISSUES_FOUND`,
  },
  {
    name: "Plan completeness",
    prompt: `You are verifying that the implementation matches the plan.

## Plan
${planContent}

## Changes
All commits since ${baseSha}. Use \`git log ${baseSha}..HEAD --oneline\` to see what was built.

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

Check:
- Do output types from one component match input types expected by the next?
- Are discriminated union variants handled exhaustively in every switch/pattern match?
- Are there any type variants added in one file but not handled in consumers?
- Do error paths propagate correctly (warnings emitted, not swallowed)?
- Are there any unused registrations (types registered but never referenced)?
- Do shared function signatures stay consistent across files? (e.g. parameter ordering)

For each finding report:
- **File(s):** paths involved
- **Issue:** what's inconsistent or missing
- **Impact:** what breaks or degrades

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
  baseSha?: string,
): Promise<void> => {
  let reviewSha = baseSha ?? (await captureRef(cwd));

  for (let cycle = 1; cycle <= CONFIG.maxReviewCycles; cycle++) {
    log(
      `\n${ts()} ${BOT_REVIEW.badge} ${a.magenta}review cycle ${cycle}/${CONFIG.maxReviewCycles}${a.reset}`,
    );

    if (!(await hasChanges(cwd, reviewSha))) {
      log(`${ts()} ${a.dim}no diff — skipping review${a.reset}`);
      break;
    }

    const reviewPrompt = reviewFirstMessage.value
      ? withBrief(buildReviewPrompt(content, reviewSha), brief)
      : buildReviewPrompt(content, reviewSha);
    let s = makeStreamer(BOT_REVIEW);
    const reviewResult = await reviewAgent.send(reviewPrompt, s);
    s.flush();
    await exitOnCreditExhaustion(reviewResult, reviewAgent);
    reviewFirstMessage.value = false;
    const reviewText = reviewResult.assistantText;

    if (!reviewText || isCleanReview(reviewText)) {
      log(`${ts()} ${a.green}✓ Review clean — no findings.${a.reset}`);
      break;
    }

    log(`${ts()} ${BOT_TDD.badge} ${a.cyan}fixing review feedback...${a.reset}`);
    const preFixSha = await captureRef(cwd);
    const fixPrompt = buildTddPrompt(content, reviewText);
    s = makeStreamer(BOT_TDD);
    const fixResult = await tddAgent.send(
      tddFirstMessage.value ? withBrief(fixPrompt, brief) : fixPrompt,
      s,
    );
    s.flush();
    tddFirstMessage.value = false;
    await followUpIfNeeded(fixResult, tddAgent, noInteraction);

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

  const planPath = resolve(getArg("--plan") ?? "plan.md");
  const auto = args.includes("--auto");
  const skipFingerprint = args.includes("--skip-fingerprint");
  const noInteraction = args.includes("--no-interaction");
  const resetState = args.includes("--reset");
  const groupFilter = getArg("--group");
  const rawThreshold = getArg("--review-threshold");
  const reviewThreshold = rawThreshold !== undefined ? Number(rawThreshold) : 30;
  if (Number.isNaN(reviewThreshold)) {
    console.error(`Invalid --review-threshold value: ${rawThreshold}`);
    process.exit(1);
  }

  // 1. Load skill prompts
  const skillsDir = resolve(import.meta.dirname, "..", "skills");
  const tddSkill = readFileSync(resolve(skillsDir, "tdd.md"), "utf-8");
  const reviewSkill = readFileSync(resolve(skillsDir, "deep-review.md"), "utf-8");

  // 2. Parse plan
  const groups = await parsePlan(planPath);
  const cwd = process.cwd();

  // 3. Fingerprint + brief
  const { brief, profile } = await runFingerprint({
    cwd,
    outputDir: resolve(cwd, CONFIG.briefDir),
    skip: skipFingerprint,
  });

  // 4. Load state
  if (resetState) {
    await clearState(resolve(cwd, CONFIG.stateFile));
    log(`${a.dim}State cleared.${a.reset}`);
  }
  let state: OrchestratorState = await loadState(resolve(cwd, CONFIG.stateFile));

  // 5. Spawn persistent agents with skill system prompts
  let tddAgent = spawnAgent(BOT_TDD, tddSkill);
  let reviewAgent = spawnAgent(BOT_REVIEW, reviewSkill);
  const tddFirstMessage = { value: true };
  const reviewFirstMessage = { value: true };

  // 6. Signal handlers
  const cleanup = () => {
    tddAgent.kill();
    reviewAgent.kill();
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
    await saveState(resolve(cwd, CONFIG.stateFile), state);
    if (signal.kind === "mid-response") {
      log(
        `${ts()} ${a.yellow}Agent was interrupted mid-response. The current slice will be re-run on resume.${a.reset}`,
      );
    }
    cleanup();
    process.exit(2);
  };

  // 7. Startup banner
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

  // 8. Group list with start marker
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

  // 9. Group loop
  for (let i = 0; i < remaining.length; i++) {
    const group = remaining[i];

    logSection(
      `Group: ${group.name} — ${group.slices.map((s: Slice) => `Slice ${s.number}`).join(", ")}`,
    );

    const groupBaseSha = await captureRef(cwd);

    // ── Slice loop ──
    let reviewBase = groupBaseSha;
    for (const slice of group.slices) {
      if (state.lastCompletedSlice !== undefined && slice.number <= state.lastCompletedSlice) {
        log(
          `\n${ts()} ${a.dim}⏭ Slice ${slice.number}: ${slice.title} — already completed${a.reset}`,
        );
        continue;
      }

      printSliceIntro(slice);

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
        const s = makeStreamer(BOT_TDD);
        const tddResult = await tddAgent.send(prompt, s);
        s.flush();
        tddFirstMessage.value = false;
        await exitOnCreditExhaustion(tddResult, tddAgent);
        await followUpIfNeeded(tddResult, tddAgent, noInteraction);

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

        state = { ...state, lastSliceImplemented: slice.number };
        await saveState(resolve(cwd, CONFIG.stateFile), state);
      }

      // Review-fix loop — gated on minimum diff threshold
      const diffStats = await measureDiff(cwd, reviewBase);
      if (!shouldReview(diffStats, reviewThreshold)) {
        log(
          `${ts()} ${a.dim}Diff too small (${diffStats.total} lines) — deferring review${a.reset}`,
        );
        // Don't advance reviewBase — let changes accumulate
        state = { ...state, lastCompletedSlice: slice.number };
        await saveState(resolve(cwd, CONFIG.stateFile), state);
        continue; // skip to next slice
      }

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
        reviewBase,
      );
      reviewBase = await captureRef(cwd);

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
      await saveState(resolve(cwd, CONFIG.stateFile), state);
    }

    // ── Gap analysis ──
    if (await hasChanges(cwd, groupBaseSha)) {
      log(
        `\n${ts()} ${BOT_GAP.badge} ${a.yellow}scanning for coverage gaps across group...${a.reset}`,
      );

      const groupContent = group.slices.map((s: Slice) => s.content).join("\n\n---\n\n");
      const gapAgent = spawnAgent(BOT_GAP);
      const gapPrompt = withBrief(buildGapPrompt(groupContent, groupBaseSha), brief);
      let s = makeStreamer(BOT_GAP);
      const gapResult = await gapAgent.send(gapPrompt, s);
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
          s = makeStreamer(BOT_TDD);
          const gapFixResult = await tddAgent.send(
            tddFirstMessage.value ? withBrief(gapFixPrompt, brief) : gapFixPrompt,
            s,
          );
          s.flush();
          tddFirstMessage.value = false;
          await exitOnCreditExhaustion(gapFixResult, tddAgent);
          await followUpIfNeeded(gapFixResult, tddAgent, noInteraction);
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
                gapBaseSha,
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

    state = { ...state, lastCompletedGroup: group.name };
    await saveState(resolve(cwd, CONFIG.stateFile), state);

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

  // 10. Final review passes
  if (await hasChanges(cwd, runBaseSha)) {
    logSection("Final review — 3 targeted passes");

    const passes = buildFinalPasses(runBaseSha, planContent);

    for (const pass of passes) {
      log(`\n${ts()} ${BOT_FINAL.badge} ${a.green}${pass.name}...${a.reset}`);

      // Fresh agent per final pass
      const finalAgent = spawnAgent(BOT_FINAL);
      const finalPrompt = withBrief(pass.prompt, brief);
      let s = makeStreamer(BOT_FINAL);
      const finalResult = await finalAgent.send(finalPrompt, s);
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
      s = makeStreamer(BOT_TDD);
      const fixResult = await tddAgent.send(
        tddFirstMessage.value ? withBrief(fixPrompt, brief) : fixPrompt,
        s,
      );
      s.flush();
      tddFirstMessage.value = false;
      await exitOnCreditExhaustion(fixResult, tddAgent);
      await followUpIfNeeded(fixResult, tddAgent, noInteraction);
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
        preFixSha,
      );
      log(`${ts()} ${a.green}✓ ${pass.name}: resolved${a.reset}`);
    }
  }

  // 11. Cleanup
  logSection(`${a.green}✅ All groups complete + final review done${a.reset}`);
  const status = await getStatus(cwd);
  log(`\n${status}`);
  cleanup();
  await clearState(resolve(cwd, CONFIG.stateFile));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
