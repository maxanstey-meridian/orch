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
 */

import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { parsePlan, type Group, type Slice } from './plan-parser.js';
import { loadState, saveState, clearState, type OrchestratorState } from './state.js';
import { runFingerprint, wrapBrief } from './fingerprint.js';
import { createAgent, type AgentProcess, type AgentResult, type AgentStyle } from './agent.js';
import { captureRef, hasChanges, getStatus } from './git.js';
import { runTestGate } from './test-gate.js';
import { isCleanReview } from './review-check.js';
import { extractFindings } from './extract-findings.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  maxReviewCycles: 3,
  stateFile: '.orchestrator-state.json',
  briefDir: '.orch',
};

// ─── ANSI ────────────────────────────────────────────────────────────────────

const a = {
  reset:      '\x1b[0m',
  bold:       '\x1b[1m',
  dim:        '\x1b[2m',
  cyan:       '\x1b[36m',
  magenta:    '\x1b[35m',
  green:      '\x1b[32m',
  red:        '\x1b[31m',
  yellow:     '\x1b[33m',
  white:      '\x1b[37m',
  bgCyan:     '\x1b[46m\x1b[30m',
  bgMagenta:  '\x1b[45m\x1b[30m',
  bgGreen:    '\x1b[42m\x1b[30m',
};

const ts = (): string => {
  const d = new Date();
  return `${a.dim}${d.toLocaleTimeString('en-GB', { hour12: false })}${a.reset}`;
};

const log = (msg: string) => console.log(msg);

const logSection = (title: string) => {
  const line = '━'.repeat(64);
  log(`\n${a.bold}${a.white}${line}${a.reset}`);
  log(`${a.bold}  ${title}${a.reset}`);
  log(`${a.bold}${a.white}${line}${a.reset}`);
};

// ─── Bot styles ──────────────────────────────────────────────────────────────

const BOT_TDD: AgentStyle    = { label: 'TDD',    color: a.cyan,    badge: `${a.bgCyan} TDD ${a.reset}` };
const BOT_REVIEW: AgentStyle = { label: 'REVIEW', color: a.magenta, badge: `${a.bgMagenta} REV ${a.reset}` };
const BOT_GAP: AgentStyle    = { label: 'GAP',    color: a.yellow,  badge: `${a.yellow}${a.bold} GAP ${a.reset}` };
const BOT_FINAL: AgentStyle  = { label: 'FINAL',  color: a.green,   badge: `${a.bgGreen} FIN ${a.reset}` };

// ─── Agent helpers ───────────────────────────────────────────────────────────

const BASE_FLAGS = ['--dangerously-skip-permissions'] as const;

const spawnAgent = (style: AgentStyle): AgentProcess =>
  createAgent({
    command: 'claude',
    args: [
      ...BASE_FLAGS,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ],
    style,
  });

// ─── Brief helper ────────────────────────────────────────────────────────────

const withBrief = (prompt: string, brief: string): string => {
  if (!brief) return prompt;
  return `${wrapBrief(brief)}\n\n${prompt}`;
};

// ─── Prompt helper ───────────────────────────────────────────────────────────

const ask = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer: string) => { rl.close(); resolve(answer); });
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

    if (!answer.trim()) {
      log(`${ts()} ${a.dim}skipped — telling bot to proceed autonomously${a.reset}`);
      current = await agent.send(
        'No preference — proceed with your best judgement. Make the decision yourself and continue implementing.',
      );
    } else {
      current = await agent.send(answer);
    }
    followUps++;
  }

  return current;
};

// ─── Prompt builders ─────────────────────────────────────────────────────────

const buildTddPrompt = (sliceContent: string, fixInstructions?: string): string => {
  if (fixInstructions) {
    return `/tdd

You are working on the following plan slice. A code review found issues — fix them.

## Plan Slice
${sliceContent}

## Review Feedback to Fix
${fixInstructions}

Fix all issues. Run tests after each change. Commit your changes when done.

## Autonomy
You are running inside an automated orchestrator. The plan slice is the spec — treat it as pre-approved.
Do NOT ask for confirmation on interface design, test strategy, or approach. Make your best judgement and proceed.
Only stop to ask if you are genuinely blocked — e.g. the plan is ambiguous in a way where the wrong choice would waste significant work, or you need information not available in the codebase. "Does this look right?" is not a valid reason to stop.`;
  }

  return `/tdd

Implement the following plan slice using red-green-refactor TDD.

## Plan Slice
${sliceContent}

Work through this slice fully. Commit your changes when done.

## Autonomy
You are running inside an automated orchestrator. The plan slice is the spec — treat it as pre-approved.
Do NOT ask for confirmation on interface design, test strategy, or approach. Make your best judgement and proceed.
Only stop to ask if you are genuinely blocked — e.g. the plan is ambiguous in a way where the wrong choice would waste significant work, or you need information not available in the codebase. "Does this look right?" is not a valid reason to stop.`;
};

const buildReviewPrompt = (sliceContent: string, baseSha: string): string =>
  `/deep-review

Review the changes since commit ${baseSha} against the intended plan slice.

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

const buildFinalPasses = (baseSha: string, planContent: string): { name: string; prompt: string }[] => [
  {
    name: 'Type fidelity',
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
    name: 'Plan completeness',
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
    name: 'Cross-cutting integration',
    prompt: `You are reviewing cross-component integration across all changes since commit ${baseSha}.

Check:
- Do output types from one component match input types expected by the next?
- Are discriminated union variants handled exhaustively in every switch/pattern match?
- Are there any TsType variants added in one file but not handled in consumers?
- Do error paths propagate correctly (warnings emitted, not swallowed)?
- Are there any unused registrations (types registered in ImportTypeRegistry but never referenced)?
- Do the static helper method signatures stay consistent across files? (e.g. parameter ordering)

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
  const introLine = slice.content.split('\n').find((l: string) => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
  if (introLine) log(`${a.dim}│  ${introLine.trim()}${a.reset}`);
  log(`${a.dim}└──${a.reset}\n`);
};

const printSliceSummary = (sliceNumber: number, summary: string) => {
  if (!summary.trim()) return;
  log('');
  log(`${a.bold}${a.green}┌─ Slice ${sliceNumber} complete ────────────────────────────${a.reset}`);
  for (const line of summary.trim().split('\n')) {
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
): Promise<void> => {
  let baseSha = await captureRef(cwd);

  for (let cycle = 1; cycle <= CONFIG.maxReviewCycles; cycle++) {
    log(`\n${ts()} ${BOT_REVIEW.badge} ${a.magenta}review cycle ${cycle}/${CONFIG.maxReviewCycles}${a.reset}`);

    if (!await hasChanges(cwd, baseSha)) {
      log(`${ts()} ${a.dim}no diff — skipping review${a.reset}`);
      break;
    }

    const reviewPrompt = reviewFirstMessage.value
      ? withBrief(buildReviewPrompt(content, baseSha), brief)
      : buildReviewPrompt(content, baseSha);
    const reviewResult = await reviewAgent.send(reviewPrompt);
    reviewFirstMessage.value = false;
    const reviewText = extractFindings(reviewResult);

    if (!reviewText || isCleanReview(reviewText)) {
      log(`${ts()} ${a.green}✓ Review clean — no findings.${a.reset}`);
      break;
    }

    log(`${ts()} ${BOT_TDD.badge} ${a.cyan}fixing review feedback...${a.reset}`);
    const preFixSha = await captureRef(cwd);
    const fixPrompt = buildTddPrompt(content, reviewText);
    const fixResult = await tddAgent.send(tddFirstMessage.value ? withBrief(fixPrompt, brief) : fixPrompt);
    tddFirstMessage.value = false;
    await followUpIfNeeded(fixResult, tddAgent, noInteraction);

    if (!await hasChanges(cwd, preFixSha)) {
      log(`${ts()} ${a.dim}TDD bot made no changes — review cycle complete${a.reset}`);
      break;
    }

    const testResult = await runTestGate({ testCommand });
    if (!testResult.passed) {
      log(`${ts()} ${a.yellow}⚠ Tests failed after review fix cycle ${cycle}. Continuing...${a.reset}`);
    }
  }
};

// ─── Main ────────────────────────────────────────────────────────────────────

const main = async () => {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const planPath = resolve(getArg('--plan') ?? 'plan.md');
  const auto = args.includes('--auto');
  const skipFingerprint = args.includes('--skip-fingerprint');
  const noInteraction = args.includes('--no-interaction');
  const groupFilter = getArg('--group');

  // 1. Parse plan
  const groups = await parsePlan(planPath);
  const cwd = process.cwd();

  // 2. Fingerprint + brief
  const { brief, profile } = await runFingerprint({
    cwd,
    outputDir: resolve(cwd, CONFIG.briefDir),
    skip: skipFingerprint,
  });

  // 3. Load state
  let state: OrchestratorState = await loadState(resolve(cwd, CONFIG.stateFile));

  // 4. Spawn persistent agents
  let tddAgent = spawnAgent(BOT_TDD);
  let reviewAgent = spawnAgent(BOT_REVIEW);
  const tddFirstMessage = { value: true };
  const reviewFirstMessage = { value: true };

  // 5. Signal handlers
  const cleanup = () => {
    tddAgent.kill();
    reviewAgent.kill();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  // 6. Startup banner
  log(`\n${a.bold}🚀 Orchestrator${a.reset} ${a.dim}${new Date().toISOString().slice(0, 16)}${a.reset}`);
  log(`   ${a.dim}Plan${a.reset}    ${planPath}`);
  log(`   ${a.dim}Brief${a.reset}   ${brief ? `${a.green}✓${a.reset} .orch/brief.md` : `${a.dim}none${a.reset}`}`);
  log(`   ${a.dim}Tests${a.reset}   ${profile.testCommand ? `${a.green}✓${a.reset} ${profile.testCommand}` : `${a.yellow}⚠ none detected${a.reset}`}`);
  log(`   ${a.dim}Mode${a.reset}    ${groupFilter ? `start from "${groupFilter}"` : auto ? 'automatic' : 'interactive'}`);
  log(`   ${BOT_TDD.badge} ${a.dim}persistent (${tddAgent.sessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_REVIEW.badge} ${a.dim}persistent (${reviewAgent.sessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_GAP.badge} ${a.dim}fresh each group${a.reset}`);

  // 7. Group list with start marker
  const startIdx = groupFilter
    ? groups.findIndex((g) => g.name.toLowerCase() === groupFilter.toLowerCase())
    : 0;

  if (groupFilter && startIdx === -1) {
    console.error(`No group "${groupFilter}". Available: ${groups.map((g) => g.name).join(', ')}`);
    cleanup();
    process.exit(1);
  }

  const remaining = groups.slice(startIdx);
  log('');
  for (let g = 0; g < remaining.length; g++) {
    const grp = remaining[g];
    const slices = grp.slices.map((s) => `${s.number}`).join(', ');
    const marker = g === 0 ? `${a.bold}▸${a.reset}` : ' ';
    log(`   ${marker} ${a.dim}${String(g + 1).padStart(2)}.${a.reset} ${g === 0 ? a.bold : a.dim}${grp.name}${a.reset} ${a.dim}(${slices})${a.reset}`);
  }
  log('');

  const runBaseSha = await captureRef(cwd);
  const planContent = await readFile(planPath, 'utf-8');

  // 8. Group loop
  for (let i = 0; i < remaining.length; i++) {
    const group = remaining[i];

    logSection(`Group: ${group.name} — ${group.slices.map((s: Slice) => `Slice ${s.number}`).join(', ')}`);

    const groupBaseSha = await captureRef(cwd);

    // ── Slice loop ──
    for (const slice of group.slices) {
      if (state.lastCompletedSlice !== undefined && slice.number <= state.lastCompletedSlice) {
        log(`\n${ts()} ${a.dim}⏭ Slice ${slice.number}: ${slice.title} — already completed${a.reset}`);
        continue;
      }

      printSliceIntro(slice);

      // Resume support: TDD done but review was interrupted
      const alreadyImplemented = state.lastSliceImplemented !== undefined
        && slice.number <= state.lastSliceImplemented
        && (state.lastCompletedSlice === undefined || slice.number > state.lastCompletedSlice);

      if (alreadyImplemented) {
        log(`${ts()} ${a.dim}⏩ TDD already ran for Slice ${slice.number} — resuming review${a.reset}`);
      } else {
        log(`${ts()} ${BOT_TDD.badge} ${a.cyan}implementing...${a.reset}`);

        const tddPrompt = buildTddPrompt(slice.content);
        const prompt = tddFirstMessage.value ? withBrief(tddPrompt, brief) : tddPrompt;
        const tddResult = await tddAgent.send(prompt);
        tddFirstMessage.value = false;
        await followUpIfNeeded(tddResult, tddAgent, noInteraction);

        if (tddResult.exitCode !== 0) {
          log(`\n${ts()} ${a.red}✗ TDD agent failed (exit ${tddResult.exitCode}) on Slice ${slice.number}. Continuing...${a.reset}`);
          continue;
        }

        // Test gate
        const testResult = await runTestGate({ testCommand: profile.testCommand });
        if (!testResult.passed) {
          log(`${ts()} ${a.red}✗ Tests failed after TDD agent on Slice ${slice.number}. Continuing...${a.reset}`);
          continue;
        }

        state = { ...state, lastSliceImplemented: slice.number };
        await saveState(resolve(cwd, CONFIG.stateFile), state);
      }

      // Review-fix loop
      await reviewFixLoop(
        tddAgent, reviewAgent, slice.content, brief, cwd, noInteraction,
        tddFirstMessage, reviewFirstMessage, profile.testCommand,
      );

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
      log(`\n${ts()} ${BOT_GAP.badge} ${a.yellow}scanning for coverage gaps across group...${a.reset}`);

      const groupContent = group.slices.map((s: Slice) => s.content).join('\n\n---\n\n');
      const gapAgent = spawnAgent(BOT_GAP);
      const gapPrompt = withBrief(buildGapPrompt(groupContent, groupBaseSha), brief);
      const gapResult = await gapAgent.send(gapPrompt);

      if (gapResult.exitCode !== 0) {
        log(`${ts()} ${a.yellow}⚠ Gap analysis agent failed (exit ${gapResult.exitCode}) — skipping${a.reset}`);
      } else {
        const gapText = extractFindings(gapResult);

        if (gapText && !gapText.includes('NO_GAPS_FOUND')) {
          log(`${ts()} ${BOT_GAP.badge} ${a.yellow}gaps found — sending to TDD bot${a.reset}`);

          const gapBaseSha = await captureRef(cwd);
          const gapFixPrompt = buildTddPrompt(
            groupContent,
            `A gap analysis found missing test coverage. Add the missing tests.\n\n## Gaps Found\n${gapText}\n\nAdd tests for each gap. Do NOT refactor or change existing code — only add tests. Commit when done.`,
          );
          const gapFixResult = await tddAgent.send(tddFirstMessage.value ? withBrief(gapFixPrompt, brief) : gapFixPrompt);
          tddFirstMessage.value = false;
          await followUpIfNeeded(gapFixResult, tddAgent, noInteraction);
          if (!await hasChanges(cwd, gapBaseSha)) {
            log(`${ts()} ${a.dim}TDD bot made no changes for gaps${a.reset}`);
          } else {
            const testResult = await runTestGate({ testCommand: profile.testCommand });
            if (!testResult.passed) {
              log(`${ts()} ${a.yellow}⚠ Tests failed after gap fixes${a.reset}`);
            } else {
              await reviewFixLoop(
                tddAgent, reviewAgent, groupContent, brief, cwd, noInteraction,
                tddFirstMessage, reviewFirstMessage, profile.testCommand,
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
      tddAgent = spawnAgent(BOT_TDD);
      reviewAgent = spawnAgent(BOT_REVIEW);
      tddFirstMessage.value = true;
      reviewFirstMessage.value = true;

      const next = remaining[i + 1];
      const nextLabel = `${next.name} (${next.slices.map((s: Slice) => `Slice ${s.number}`).join(', ')})`;

      if (auto || noInteraction) {
        log(`\n${ts()} ${a.dim}→ next: ${nextLabel}${a.reset}`);
      } else {
        const answer = await ask(`\n${ts()} Group done. Run ${a.bold}${nextLabel}${a.reset} next? (Y/n) `);
        if (answer.toLowerCase() === 'n') {
          log(`Stopped. Resume with --group "${next.name}"`);
          cleanup();
          process.exit(0);
        }
      }
    }
  }

  // 9. Final review passes
  if (await hasChanges(cwd, runBaseSha)) {
    logSection('Final review — 3 targeted passes');

    const passes = buildFinalPasses(runBaseSha, planContent);

    for (const pass of passes) {
      log(`\n${ts()} ${BOT_FINAL.badge} ${a.green}${pass.name}...${a.reset}`);

      // Fresh agent per final pass
      const finalAgent = spawnAgent(BOT_FINAL);
      const finalPrompt = withBrief(pass.prompt, brief);
      const finalResult = await finalAgent.send(finalPrompt);
      finalAgent.kill();

      if (finalResult.exitCode !== 0) {
        log(`${ts()} ${a.dim}${pass.name}: agent failed — skipping${a.reset}`);
        continue;
      }

      const findings = extractFindings(finalResult);

      if (!findings || findings.includes('NO_ISSUES_FOUND')) {
        log(`${ts()} ${a.green}✓ ${pass.name}: clean${a.reset}`);
        continue;
      }

      log(`${ts()} ${BOT_FINAL.badge} ${a.yellow}${pass.name}: issues found${a.reset}`);

      // Fix cycle for final pass findings
      log(`${ts()} ${BOT_TDD.badge} ${a.cyan}fixing ${pass.name} findings...${a.reset}`);

      const preFixSha = await captureRef(cwd);
      const fixPrompt = buildTddPrompt(
        planContent,
        `A final "${pass.name}" review found issues. Fix them all.\n\n## Findings\n${findings}\n\nFix each issue. Run tests after each change. Commit when done.`,
      );
      const fixResult = await tddAgent.send(tddFirstMessage.value ? withBrief(fixPrompt, brief) : fixPrompt);
      tddFirstMessage.value = false;
      await followUpIfNeeded(fixResult, tddAgent, noInteraction);
      if (!await hasChanges(cwd, preFixSha)) {
        log(`${ts()} ${a.dim}TDD bot made no changes for ${pass.name}${a.reset}`);
        continue;
      }

      const testResult = await runTestGate({ testCommand: profile.testCommand });
      if (!testResult.passed) {
        log(`${ts()} ${a.yellow}⚠ Tests failed after ${pass.name} fixes — continuing with next pass${a.reset}`);
        continue;
      }

      // Review cycle on the fixes
      await reviewFixLoop(
        tddAgent, reviewAgent, planContent, brief, cwd, noInteraction,
        tddFirstMessage, reviewFirstMessage, profile.testCommand,
      );
      log(`${ts()} ${a.green}✓ ${pass.name}: resolved${a.reset}`);
    }
  }

  // 10. Cleanup
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
