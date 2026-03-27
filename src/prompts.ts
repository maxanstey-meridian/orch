import { wrapBrief } from "./fingerprint.js";

export const withBrief = (prompt: string, brief: string): string => {
  if (!brief) return prompt;
  return `${wrapBrief(brief)}\n\n${prompt}`;
};

export const buildPlanPrompt = (sliceContent: string): string =>
  `You are a planning agent. Explore the codebase and produce a step-by-step TDD execution plan for the following slice.

## Plan Slice
${sliceContent}

## Instructions
1. Read the relevant files to understand current state.
2. Output numbered RED→GREEN cycles. Each cycle: one failing test, then minimal code to pass.
3. Do NOT write any code — plan only.`;

export const buildTddPrompt = (sliceContent: string, fixInstructions?: string): string => {
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

export const buildReviewPreamble = (baseSha: string): string =>
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

export const buildReviewPrompt = (sliceContent: string, baseSha: string): string =>
  `Review the code changed since commit ${baseSha}. Judge the code on its own merits — correctness, types, structure — not just whether it matches the plan.

${buildReviewPreamble(baseSha)}

## What to look for
- Bugs: incorrect runtime behavior, off-by-one, swallowed errors, race conditions
- Type fidelity: runtime values disagreeing with declared types, \`any\`/\`unknown\` as value carriers
- Dead code: new exports with zero consumers introduced by the change
- Structural: duplicated logic, parallel state, mixed concerns introduced by the change
- Names: identifiers that no longer match their scope or purpose after the change
- Enum/value completeness: new variants not handled in all consumers
- Over-engineering: deps bags, wrapper types, or indirection layers that exist "for testability" but add complexity with no real benefit. If a function is only called from one place, it doesn't need to be injectable. If a value is available on \`this\`, don't thread it through a params object. Prefer direct imports over DI for pure functions and leaf I/O. Three lines of duplication beats a premature abstraction

## What NOT to flag
- Style, formatting, cosmetic preferences
- Test coverage gaps (separate pass handles this)
- Harmless redundancy that aids readability
- Threshold values tuned empirically
- Missing wiring to call sites that a LATER slice will handle — do not flag functions that exist but aren't called yet. However, bugs, type errors, dead code, and structural issues within the changed files are always in scope, even if the file is "not done yet."

## Plan Slice (for context, not as acceptance criteria)
${sliceContent}

If all changes are correct and well-structured, respond with exactly: REVIEW_CLEAN`;

export const buildGapPrompt = (groupContent: string, baseSha: string): string =>
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

export const buildFinalPasses = (
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
