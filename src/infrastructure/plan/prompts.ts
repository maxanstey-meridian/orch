import { wrapBrief } from "../fingerprint.js";

export const withBrief = (prompt: string, brief: string): string => {
  if (!brief) {
    return prompt;
  }
  return `${wrapBrief(brief)}\n\n${prompt}`;
};

export const buildPlanPrompt = (
  sliceContent: string,
  fullPlan?: string,
  sliceNumber?: number,
): string =>
  `You are a planning agent. Explore the codebase and produce a step-by-step TDD execution plan for the following slice.
${
  fullPlan
    ? `
## Full Plan Context
The slice below is part of a larger plan. Read this for context on what has already been built in prior slices and what will be built in later slices. **You are planning Slice ${sliceNumber ?? "N"} ONLY** — do not plan work for other slices.

${fullPlan}

---
`
    : ""
}
## Your Slice (Slice ${sliceNumber ?? "N"})
${sliceContent}

## Instructions
1. Read the relevant files to understand current state.
2. Output numbered RED→GREEN cycles. Each cycle: one failing test, then minimal code to pass.
3. Do NOT write any code — plan only.
4. The plan describes the INTENT. If existing code does something different from what the plan describes, the plan is the authority — plan to change the existing code, not to preserve it.

## Enrichment
As you explore, capture the context you discover so the implementing agent doesn't have to re-explore. Include in your output:
- **relatedFiles**: paths the implementing agent should read beyond the primary files
- **keyContext**: what the agent needs to know about the current state of the code (how things are wired, what patterns exist)
- **dependsOn**: if this slice depends on output from a prior slice, note which slice and what specifically
- **testPatterns**: how the existing tests work (helpers, mocking patterns, assertion style)
- **signatures**: key type signatures the agent will need to know (current method signatures, port contracts)
- **gotchas**: non-obvious constraints or traps (phase machine rules, abstract methods that need implementing, sandbox restrictions)`;

export const buildTddPrompt = (
  sliceContent: string,
  fixInstructions?: string,
  fullPlan?: string,
  sliceNumber?: number,
): string => {
  const planContext = fullPlan
    ? `## Full Plan Context
This slice is part of a larger plan. Read this to understand the bigger picture — what was built in prior slices, what this slice is supposed to achieve, and how it fits into the whole. **You are implementing Slice ${sliceNumber ?? "N"} ONLY.**

${fullPlan}

---
`
    : "";

  const integration = `## Integration
Before writing any code for this slice, read the existing codebase to understand how this capability is currently implemented (if at all). Check for existing utilities, scripts, patterns, and external files referenced in the plan or brief that should be reused. Your implementation must integrate with the real system, not exist in isolation.`;

  const autonomy = `## Autonomy
You are running inside an automated orchestrator. The plan slice is the spec — treat it as pre-approved.
Do NOT ask for confirmation on interface design, test strategy, or approach. Make your best judgement and proceed.
Only stop to ask if you are genuinely blocked — e.g. the plan is ambiguous in a way where the wrong choice would waste significant work, or you need information not available in the codebase. "Does this look right?" is not a valid reason to stop.`;

  const planAuthority = `## Plan Authority
The plan describes the INTENT — it is the authority, not the existing code. If the plan says "filter by X" but existing code does "include everything", you must change the existing code to match the plan. Do not preserve existing behavior that contradicts the plan. Do not add the plan's feature on top of conflicting existing behavior.`;

  const fixDiscipline = `## Fix Discipline
When review, completeness, gap, or final-pass feedback identifies a concrete defect or missing behavior, treat it as an implementation obligation by default.
Do not downgrade a real implementation finding into "tests only", an expected-failing test, a TODO, or a note that the issue remains open unless the feedback explicitly says the pass is test-only or docs-only.
If the reviewer/gap pass tells you to implement a non-egregious fix, do it rather than arguing with it.
If you believe a finding is wrong, prove that with code evidence and passing tests. Otherwise, apply the fix.
"I did not change implementation code" is not an acceptable response to an implementation finding.`;

  if (fixInstructions) {
    return `A code review found issues with the current plan slice. Address them.
${planContext}
## Plan Slice
${sliceContent}

## Review Feedback
${fixInstructions}

${integration}

${autonomy}

${planAuthority}

${fixDiscipline}`;
  }

  return `Implement the following plan slice using strict RED→GREEN TDD cycles.

The plan slice contains numbered cycles with RED and GREEN blocks. Follow them in order:
1. Write the test described in RED. Run tests. Confirm it fails.
2. Write the minimal code described in GREEN. Run tests. Confirm it passes.
3. Move to the next cycle. Do NOT skip ahead or batch.

If the plan slice does not contain explicit cycles, decompose it into behaviours yourself and apply the same process: one failing test, then minimal code to pass, repeat.
${planContext}
## Plan Slice
${sliceContent}

${integration}

${autonomy}

${planAuthority}`;
};

export const buildVerifyPrompt = (
  baseSha: string,
  sliceNumber: number,
  fixSummary?: string,
): string =>
  `Verify the changes since commit ${baseSha}. Context: TDD implementation of Slice ${sliceNumber}.

${fixSummary ? `## Fix summary from the TDD bot\n${fixSummary}\n\n` : ""}## Instructions
1. Review the changed code and run the verification commands you judge necessary.
2. You MUST end with a structured result block in the exact format below.
3. Do not replace the structured block with prose. You may include prose before it, but the block is mandatory.

## Required output format

### VERIFY_RESULT

**Status:** PASS|FAIL|PASS_WITH_WARNINGS

**Checks run:**
- <check>: PASS|FAIL|WARN

**New failures** (caused by recent changes):
- <failure>
or:
None

**Pre-existing failures** (already failing before these changes):
- <failure>
or:
None

**Scope rationale:** <why this verification scope was sufficient>

Rules:
- If there are no new failures, use PASS or PASS_WITH_WARNINGS.
- "No findings" prose alone is NOT sufficient; you must include the block above.
- Only use FAIL when there are real new failures caused by the recent changes.`;

export const buildCompletenessPrompt = (
  sliceContent: string,
  baseSha: string,
  fullPlan?: string,
  sliceNumber?: number,
): string =>
  `You are a completeness checker. A TDD bot just implemented a plan slice. Your job is to verify that EVERY requirement in the slice was actually implemented — not whether the code is clean, but whether it does what was asked.

${
  fullPlan
    ? `## Full Plan Context
This slice is part of a larger plan. Use this to understand the INTENT behind each requirement — what the slice is supposed to achieve within the bigger picture.

${fullPlan}

---
`
    : ""
}
## Slice ${sliceNumber ?? "N"} (the slice that was just implemented)
${sliceContent}

## How to check

1. Run \`git diff --name-only ${baseSha}..HEAD\` to see what changed.
2. Read the changed files — the FULL files, not just diffs.
3. For EACH concrete requirement in the slice above, check:
   - **Is it implemented?** Find the code that does it. Cite the file and line.
   - **Does it match the plan's intent?** If the plan says "filter by X" but the code "includes everything and also X", that is WRONG — the plan is the authority.
   - **Is there a test?** Find a test that would fail if this requirement were removed.
4. Check ARCHITECTURAL requirements separately from functional ones:
   - If the plan says "use function X" or "call Y from domain layer", verify the import exists and the function is actually called. Grep for it.
   - If the plan says "phase transitions use transition()" or "state advances use advanceState()", those are HARD REQUIREMENTS — not suggestions. Code that manages state a different way (e.g. manual object spreads instead of advanceState) is MISSING the requirement even if tests pass.
   - The plan's specified approach IS the requirement. An equivalent alternative that the TDD bot chose instead is a DIVERGENT finding.

## Output format

For each requirement, output one line:
- ✅ **<requirement>** — implemented at \`file:line\`, tested in \`test-file\`
- ❌ **<requirement>** — MISSING: <what's wrong or missing>
- ⚠️ **<requirement>** — DIVERGENT: <how it differs from the plan's intent>

If everything is complete and matches the plan, respond with exactly: SLICE_COMPLETE

If anything is missing or divergent, list ALL issues. Do not stop at the first one.`;

export const buildCommitSweepPrompt = (groupName: string): string =>
  `There are uncommitted changes in the working tree. Review them and commit ONLY files that belong to the "${groupName}" group's work.

## Group
${groupName}

## Instructions
1. Run \`git status\` and \`git diff\` to see what changed.
2. Stage and commit ONLY files that clearly belong to this group's work with a descriptive message. Use \`git add <specific files>\` — never \`git add .\` or \`git add -A\`.
3. **Leave everything else alone.** Do not stash, discard, revert, or touch unrelated files. They belong to the operator.`;

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

export const buildReviewPrompt = (
  sliceContent: string,
  baseSha: string,
  priorFindings?: string,
): string =>
  `Review the code changed since commit ${baseSha}. Judge the code on its own merits — correctness, types, structure — not just whether it matches the plan.

${priorFindings ? `## Prior review findings\nYour previous review flagged these issues — verify each one was addressed. If any were ignored or only partially fixed, re-flag them:\n\n${priorFindings}\n\n` : ""}${buildReviewPreamble(baseSha)}

## What to look for
- Bugs: incorrect runtime behavior, off-by-one, swallowed errors, race conditions
- Type fidelity: runtime values disagreeing with declared types, \`any\`/\`unknown\` as value carriers
- Dead code: new exports with zero consumers introduced by the change
- Structural: duplicated logic, parallel state, mixed concerns introduced by the change
- Names: identifiers that no longer match their scope or purpose after the change
- Enum/value completeness: new variants not handled in all consumers
- Over-engineering: deps bags, wrapper types, or indirection layers that exist "for testability" but add complexity with no real benefit. If a function is only called from one place, it doesn't need to be injectable. If a value is available on \`this\`, don't thread it through a params object. Prefer direct imports over DI for pure functions and leaf I/O. Three lines of duplication beats a premature abstraction
- Test resilience: new tests that mock the system under test, tests that would pass even if the feature were removed, tests that assert mock call arguments instead of observable outcomes

## What NOT to flag
- Style, formatting, cosmetic preferences
- Test coverage gaps (separate pass handles this)
- Harmless redundancy that aids readability
- Threshold values tuned empirically
- Test style preferences (describe/it nesting, assertion library choice)
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

## Test resilience check

For each test file changed in this group, evaluate:

1. **Regression guard:** For each new feature/behavior, could someone remove the key implementation line and all
   tests still pass? If yes, flag it as: **Unguarded:** <feature> — <what line could be removed without test failure>

2. **Mock dependency:** Are any tests mocking the thing they're supposed to be testing? (e.g. mocking a function
   and then asserting the mock was called — that proves nothing about the real function)

3. **State assertion:** Does the test verify observable state changes? If a feature sets a flag/field, is that
   flag/field directly asserted — or is it only tested indirectly through a mock?

4. **Integration path:** If a feature spans setup → action → effect across multiple methods, is there at least one
   test that exercises the full path without mocking intermediate steps?

Report unguarded features as gaps, same format as coverage gaps.

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
