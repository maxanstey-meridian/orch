import type { RepoContextData } from "#domain/context.js";
import type { PlannedExecutionMode } from "#domain/plan.js";
import { renderRepoContextForPrompt } from "../context/context-brief.js";
import { wrapBrief } from "../fingerprint.js";

export const withBrief = (prompt: string, brief: string): string => {
  if (!brief) {
    return prompt;
  }
  return `${wrapBrief(brief)}\n\n${prompt}`;
};

export const hasCriteriaSection = (content: string): boolean => content.includes("**Criteria:**");

const PLAN_GENERATION_SHARED_INSTRUCTIONS = `Transform this feature inventory into a group-and-slice plan.

**You are generating the HIGH-LEVEL plan structure, NOT per-cycle TDD plans.** Ignore the Cycle N format from your system prompt — that is for a different task.

## Required format

Output valid JSON matching this schema:

\`\`\`json
{
  "executionMode": "<grouped|sliced>",
  "context": {
    "architecture": "<optional architecture summary>",
    "keyFiles": {
      "src/foo.ts": "<why this file matters>"
    },
    "concepts": {
      "someConcept": "<important product/runtime concept>"
    },
    "conventions": {
      "testingBias": "<important implementation or testing convention>"
    }
  },
  "contextUpdates": {
    "architecture": "<updated architecture insight discovered during planning>",
    "keyFiles": { "src/new.ts": "<why this newly-discovered file matters>" }
  },
  "groups": [
    {
      "name": "<group name>",
      "description": "<optional group description>",
      "slices": [
        {
          "number": 1,
          "title": "<slice title>",
          "why": "<one sentence explaining why this slice is needed>",
          "files": [
            { "path": "src/foo.ts", "action": "new" },
            { "path": "src/bar.ts", "action": "edit" }
          ],
          "criteria": ["<binary acceptance criterion>"],
          "details": "<concrete implementation details — what to build, how it connects>",
          "tests": "<what to test, which file>"
        }
      ]
    }
  ]
}
\`\`\`

## Field reference

- \`"executionMode"\` must be \`"grouped"\` or \`"sliced"\`, and it must match the requested planning mode.
- \`"action"\` must be one of: \`"new"\`, \`"edit"\`, \`"delete"\`.
- \`"number"\` is a positive integer — globally unique across the entire plan.
- \`"files"\` must have at least one entry per slice.
- \`"criteria"\` must be a non-empty array of binary acceptance checks for that slice.
- All string fields (\`"name"\`, \`"title"\`, \`"why"\`, \`"details"\`, \`"tests"\`) must be non-empty.
- Top-level \`"context"\` is optional, but include it when you can infer useful repo-wide guidance that will reduce re-exploration for implementing agents.
- Within \`"context"\`, \`"architecture"\` is an optional string and \`"keyFiles"\`, \`"concepts"\`, and \`"conventions"\` are optional string-to-string maps.
- Top-level \`"contextUpdates"\` is optional. Use it to return repo-wide facts you discovered during planning that should be merged back into the canonical repo context. Same shape as \`"context"\`. Only include genuinely new or corrected knowledge — do not echo back what was already provided in the canonical repo context.

## Rules

- **Slice numbers must be GLOBALLY unique and sequential across the entire plan.** Group 1 has Slices 1-3, Group 2 has Slices 4-6, etc. Do NOT restart numbering per group. The orchestrator tracks progress by slice number — duplicate numbers cause slices to be skipped.
- Every generated slice must include a non-empty \`criteria\` array of binary acceptance checks that downstream evaluators can verify mechanically.
- Use top-level \`"context"\` for stable repo knowledge only: architecture boundaries, authoritative files, product/runtime concepts, and conventions that apply across multiple slices. Do not duplicate slice-specific details there.
- The plan agent is the sole author of criteria in this iteration. Do not add a separate contract-negotiation phase or defer criteria authoring to later agents.
- The generated plan is authoritative. Do not invent compatibility shims, legacy fallback, coercion, or fail-open behavior unless the inventory explicitly requires them.
- Future-slice wiring stays deferred. Do not pull later integration work forward just to make the current group or slice feel complete.
- Output ONLY the raw JSON object. No markdown code fences, no \`\`\`json blocks, no preamble, no commentary, no explanation before or after. The very first character of your response must be \`{\` and the very last must be \`}\`.`;

const buildGroupedPlanGenerationRules = (): string => `## Grouped mode requirements

- Set \`"executionMode": "grouped"\`.
- Produce coarse groups with independently meaningful deliverables.
- Make it obvious that review/verify cadence is driven by group boundaries, not by every internal slice.
- Prefer a small number of larger internal steps with tolerance for larger internal change sets when the boundary deliverable stays coherent.
- Reject micro-slice churn. Do not default to 2-3 tiny slices per group just because sliced mode would.`;

const buildSlicedPlanGenerationRules = (): string => `## Sliced mode requirements

- Set \`"executionMode": "sliced"\`.
- Use finer-grained groups and slices where dependency ordering benefits from tighter review/verify cadence.
- Target 2-3 slices per group, max 4. Respect dependency ordering.`;

export const buildPlanGenerationPrompt = (
  targetExecutionMode: PlannedExecutionMode,
  repoContext?: RepoContextData,
): string => {
  const modeRules =
    targetExecutionMode === "grouped"
      ? buildGroupedPlanGenerationRules()
      : buildSlicedPlanGenerationRules();

  const repoContextSection =
    repoContext !== undefined ? `\n\n${renderRepoContextForPrompt(repoContext)}` : "";

  return `${PLAN_GENERATION_SHARED_INSTRUCTIONS}

${modeRules}${repoContextSection}`;
};

export const buildPlanPrompt = (
  sliceContent: string,
  fullPlan?: string,
  sliceNumber?: number,
): string =>
  `Before implementing this slice, produce a concise execution brief for yourself as the builder.
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
2. Output a numbered implementation brief for this slice only.
3. Do NOT write any code in this response.
4. The plan describes the INTENT. If existing code does something different from what the plan describes, the plan is the authority — plan to change the existing code, not to preserve it.
5. Future-slice wiring stays deferred. Do not turn later planned integration into a requirement for the current slice unless the plan explicitly says to do it now.
6. Compatibility/fallback behavior must be stated, not invented. If the slice does not explicitly preserve legacy behavior, plan explicit invalid handling rather than silent reinterpretation.
7. Include test obligations, but do not force fake RED→GREEN ceremony.

## Enrichment
As you explore, capture only the context that will save real re-exploration during implementation. Include in your output:
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
  const criteriaChecklist = hasCriteriaSection(sliceContent)
    ? `
## Criteria coverage
Treat the \`**Criteria:**\` section in the slice as a mandatory criteria coverage checklist.
For each criterion in the \`**Criteria:**\` section:
- implement the behavior explicitly, not just adjacent prose requirements
- add at least one regression guard per criterion
- do not move on until the criterion has code coverage that would fail if the key implementation line were removed
`
    : "";
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

${criteriaChecklist}

${integration}

${autonomy}

${planAuthority}

${fixDiscipline}`;
  }

  return `Implement the following plan slice as the builder.

Work through the slice as one bounded implementation task.
Use the plan as the authority for what to build, do not turn it into fake RED→GREEN ceremony, write real regression
guards, run the relevant tests, and only claim completion after the code and tests are actually green.
${planContext}
## Plan Slice
${sliceContent}

${criteriaChecklist}

${integration}

${autonomy}

${planAuthority}`;
};

export const buildDirectExecutePrompt = (requestContent: string): string =>
  `Implement the following bounded whole request as one direct-mode execution unit.

keep scope narrow. Do not drift into future work outside this request.

## Request
${requestContent}

## Builder contract
- Implement the whole bounded request without reframing it as slice-based or plan-driven work.
- After implementation, you must run the mandatory test pass for this direct request.
- Reuse real codebase patterns and integrate with the existing system rather than building in isolation.

## Inference policy
- Do not invent compatibility, legacy fallback, coercion, or migration shims unless this request explicitly requires them.
- Do not add fail-open behavior when the request does not specify it.
- Do not perform fake RED/GREEN ceremony or claim tests passed without running them.
- Prefer explicit invalid handling over silent reinterpretation when behavior is underspecified.`;

export const buildDirectTestPassPrompt = (requestContent: string): string =>
  `Run the mandatory test pass for this direct request.

Review the whole bounded increment, run the relevant tests, and explain:
- changed behavior
- regression risks
- tests added or updated
- why those tests are useful

Do not invent future work. Keep the report scoped to this request.

## Request
${requestContent}`;

export const buildVerifyPrompt = (
  baseSha: string,
  executionUnitLabel: string,
  fixSummary?: string,
): string =>
  `Verify the changes since commit ${baseSha}. Context: builder implementation of ${executionUnitLabel}.

${fixSummary ? `## Fix summary from the builder\n${fixSummary}\n\n` : ""}## Instructions
1. Review the changed code and run the verification commands you judge necessary.
2. You MUST end with a short human summary followed by a machine-readable \`### VERIFY_JSON\` block in the exact format below.
3. Do not replace the structured block with prose. You may include prose before it, but the block is mandatory.

## Required output format

### VERIFY_JSON
\`\`\`json
{
  "status": "PASS|FAIL|PASS_WITH_WARNINGS",
  "checks": [
    { "check": "<command or check name>", "status": "PASS|FAIL|WARN|SKIPPED" }
  ],
  "sliceLocalFailures": ["<failure caused by the current execution unit>"],
  "outOfScopeFailures": ["<failure not owned by the current execution unit>"],
  "preExistingFailures": ["<failure that already existed before these changes>"],
  "runnerIssue": "<runner instability or hung process summary>" | null,
  "retryable": true,
  "summary": "<one concise summary sentence>"
}
\`\`\`

Rules:
- \`sliceLocalFailures\` are the ONLY failures the builder should be asked to fix.
- Put unrelated failures in \`outOfScopeFailures\`, not \`sliceLocalFailures\`.
- Put already-failing checks in \`preExistingFailures\`.
- Use \`runnerIssue\` for hung runners, crashed tooling, or unstable infrastructure rather than blaming the builder.
- If the current execution unit is clean, use PASS or PASS_WITH_WARNINGS and leave \`sliceLocalFailures\` empty.
- "No findings" prose alone is NOT sufficient; you must include the JSON block above.`;

export const buildDirectVerifyPrompt = (
  baseSha: string,
  requestContent: string,
  fixSummary?: string,
): string =>
  `Verify the changes since commit ${baseSha}. Context: builder implementation of the direct request.

${fixSummary ? `## Fix summary from the builder\n${fixSummary}\n\n` : ""}## Direct request
${requestContent}

## Instructions
1. Review the changed code and run the verification commands you judge necessary.
2. You MUST end with a short human summary followed by a machine-readable \`### VERIFY_JSON\` block in the exact format below.
3. Do not replace the structured block with prose. You may include prose before it, but the block is mandatory.

## Required output format

### VERIFY_JSON
\`\`\`json
{
  "status": "PASS|FAIL|PASS_WITH_WARNINGS",
  "checks": [
    { "check": "<command or check name>", "status": "PASS|FAIL|WARN|SKIPPED" }
  ],
  "sliceLocalFailures": ["<failure caused by the current execution unit>"],
  "outOfScopeFailures": ["<failure not owned by the current execution unit>"],
  "preExistingFailures": ["<failure that already existed before these changes>"],
  "runnerIssue": "<runner instability or hung process summary>" | null,
  "retryable": true,
  "summary": "<one concise summary sentence>"
}
\`\`\`

Rules:
- \`sliceLocalFailures\` are the ONLY failures the builder should be asked to fix.
- Put unrelated failures in \`outOfScopeFailures\`, not \`sliceLocalFailures\`.
- Put already-failing checks in \`preExistingFailures\`.
- Use \`runnerIssue\` for hung runners, crashed tooling, or unstable infrastructure rather than blaming the builder.
- If the direct request is clean, use PASS or PASS_WITH_WARNINGS and leave \`sliceLocalFailures\` empty.
- "No findings" prose alone is NOT sufficient; you must include the JSON block above.`;

export const buildCompletenessPrompt = (
  sliceContent: string,
  baseSha: string,
  fullPlan?: string,
  sliceNumber?: number,
): string => {
  const planContext = fullPlan
    ? `## Full Plan Context
This slice is part of a larger plan. Use this to understand the INTENT behind each requirement — what the slice is supposed to achieve within the bigger picture.

${fullPlan}

---
`
    : "";

  if (hasCriteriaSection(sliceContent)) {
    return `You are a completeness checker. A builder just implemented a plan slice. Your job is to verify that EVERY criterion and concrete requirement in the slice was actually implemented — not whether the code is clean, but whether it does what was asked.

${planContext}
## Slice ${sliceNumber ?? "N"} (the slice that was just implemented)
${sliceContent}

## How to check

1. Run \`git diff --name-only ${baseSha}..HEAD\` to see what changed.
2. Read the changed files — the FULL files, not just diffs.
3. Inspect the \`**Criteria:**\` section first.
4. For each criterion in that section:
   - Report PASS, FAIL, or DIVERGENT for each criterion
   - decide whether it is PASS, FAIL, or DIVERGENT
   - cite both code evidence and test evidence
   - treat a missing regression guard as FAIL even if the behavior appears implemented
5. After the criteria section, check any remaining concrete non-criteria requirements in the slice above.
6. Check ARCHITECTURAL requirements separately from functional ones:
   - If the plan says "use function X" or "call Y from domain layer", verify the import exists and the function is actually called. Grep for it.
   - If the plan says "phase transitions use transition()" or "state advances use advanceState()", those are HARD REQUIREMENTS — not suggestions. Code that manages state a different way (e.g. manual object spreads instead of advanceState) is MISSING the requirement even if tests pass.
   - The plan's specified approach IS the requirement. An equivalent alternative that the builder chose instead is a DIVERGENT finding.

## Output format

For each criterion, output one line:
- PASS **<criterion>** — code: \`file:line\`; test: \`test-file:line\`
- FAIL **<criterion>** — <what is missing>; code: \`file:line|none\`; test: \`test-file:line|none\`
- DIVERGENT **<criterion>** — <how it differs from the plan>; code: \`file:line\`; test: \`test-file:line|none\`

After the criteria lines, output any additional requirement-level findings as needed:
- ✅ **<requirement>** — implemented at \`file:line\`, tested in \`test-file\`
- ❌ **<requirement>** — MISSING: <what's wrong or missing>
- ⚠️ **<requirement>** — DIVERGENT: <how it differs from the plan's intent>

If everything is complete and matches the plan, respond with exactly: SLICE_COMPLETE

If anything is missing or divergent, list ALL issues. Do not stop at the first one.`;
  }

  return `You are a completeness checker. A builder just implemented a plan slice. Your job is to verify that EVERY requirement in the slice was actually implemented — not whether the code is clean, but whether it does what was asked.

${planContext}
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
   - The plan's specified approach IS the requirement. An equivalent alternative that the builder chose instead is a DIVERGENT finding.

## Output format

For each requirement, output one line:
- ✅ **<requirement>** — implemented at \`file:line\`, tested in \`test-file\`
- ❌ **<requirement>** — MISSING: <what's wrong or missing>
- ⚠️ **<requirement>** — DIVERGENT: <how it differs from the plan's intent>

If everything is complete and matches the plan, respond with exactly: SLICE_COMPLETE

  If anything is missing or divergent, list ALL issues. Do not stop at the first one.`;
};

export const buildDirectCompletenessPrompt = (requestContent: string, baseSha: string): string =>
  `You are a completeness checker. A builder just implemented the direct request below as one bounded increment. Your job is to verify that EVERY stated requirement in the request was actually implemented — not whether the code is clean, but whether it does what was asked.

## Direct request
${requestContent}

## How to check

1. Run \`git diff --name-only ${baseSha}..HEAD\` to see what changed.
2. Read the changed files — the FULL files, not just diffs.
3. For EACH concrete requirement in the direct request above, check:
   - **Is it implemented?** Find the code that does it. Cite the file and line.
   - **Does it match the request's intent?** If the request says "filter by X" but the code "includes everything and also X", that is WRONG — the direct request is the authority.
   - **Is there a test?** Find a test that would fail if this requirement were removed.
4. Check ARCHITECTURAL requirements separately from functional ones:
   - If the request says "use function X" or "call Y from domain layer", verify the import exists and the function is actually called. Grep for it.
   - If the request says "phase transitions use transition()" or "state advances use advanceState()", those are HARD REQUIREMENTS — not suggestions. Code that manages state a different way is MISSING the requirement even if tests pass.
   - The request's specified approach IS the requirement. An equivalent alternative that the builder chose instead is a DIVERGENT finding.

## Output format

For each requirement, output one line:
- ✅ **<requirement>** — implemented at \`file:line\`, tested in \`test-file\`
- ❌ **<requirement>** — MISSING: <what's wrong or missing>
- ⚠️ **<requirement>** — DIVERGENT: <how it differs from the request's intent>

If everything is complete and matches the request, respond with exactly: DIRECT_COMPLETE

If anything is missing or divergent, list ALL issues. Do not stop at the first one.`;

export const buildGroupedCompletenessPrompt = (
  groupContent: string,
  baseSha: string,
  fullPlan: string,
  groupName: string,
): string => {
  if (hasCriteriaSection(groupContent)) {
    return `You are a completeness checker. A builder just implemented Group ${groupName} as one bounded increment. Verify that the grouped deliverable matches the plan content below, that every slice in the group is actually covered, and that EVERY criterion and concrete requirement in the group was actually implemented.

## Full Plan Context
${fullPlan}

---

## Group ${groupName}
${groupContent}

## How to check

1. Run \`git diff --name-only ${baseSha}..HEAD\` to see what changed.
2. Read the changed files in full.
3. Inspect the \`**Criteria:**\` sections first.
4. For each criterion in the group content:
   - Report PASS, FAIL, or DIVERGENT for each criterion
   - decide whether it is PASS, FAIL, or DIVERGENT
   - cite both code evidence and test evidence
   - treat a missing regression guard as FAIL even if the behavior appears implemented
5. After the criteria lines, check any remaining concrete non-criteria requirements in the group content.

## Output format

For each criterion, output one line:
- PASS **<criterion>** — code: \`file:line\`; test: \`test-file:line\`
- FAIL **<criterion>** — <what is missing>; code: \`file:line|none\`; test: \`test-file:line|none\`
- DIVERGENT **<criterion>** — <how it differs from the plan>; code: \`file:line\`; test: \`test-file:line|none\`

After the criteria lines, output any additional requirement-level findings as needed:
- ✅ **<requirement>** — implemented at \`file:line\`, tested in \`test-file\`
- ❌ **<requirement>** — MISSING: <what's wrong or missing>
- ⚠️ **<requirement>** — DIVERGENT: <how it differs from the plan's intent>

If everything is complete, respond with exactly: GROUP_COMPLETE

If anything is missing or divergent, list ALL issues.`;
  }

  return `You are a completeness checker. A builder just implemented Group ${groupName} as one bounded increment. Verify that the grouped deliverable matches the plan content below and that every slice in the group is actually covered.

## Full Plan Context
${fullPlan}

---

## Group ${groupName}
${groupContent}

## How to check

1. Run \`git diff --name-only ${baseSha}..HEAD\` to see what changed.
2. Read the changed files in full.
3. Check that every concrete requirement in the group content is implemented and covered by a test that would fail if the requirement were removed.

If everything is complete, respond with exactly: GROUP_COMPLETE

If anything is missing or divergent, list ALL issues.`;
};

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
  followUp = false,
): string => {
  const criteriaCheck = hasCriteriaSection(sliceContent)
    ? `
## Criteria check
Check each criterion in the \`**Criteria:**\` section and verify whether the built code and tests actually satisfy it.
If a criterion is not met, surface that as a material finding with code and test evidence.
When criteria are present, include a \`## Criteria check\` section in your output summarising whether each criterion is satisfied.
`
    : "";

  const planSliceSection = hasCriteriaSection(sliceContent)
    ? `## Plan Slice
${sliceContent}`
    : `## Plan Slice (for context, not as acceptance criteria)
${sliceContent}`;

  return `Review the code changed since commit ${baseSha}. Judge the code on its own merits — correctness, types, structure — not just whether it matches the plan.

${
  followUp
    ? `## Review pass discipline
This is a follow-up review in the same conversation.
Re-check the concerns you already raised from memory before surfacing anything new.
Only report issues that are still open or genuinely new and material.
Batch related issues into one finding when they share a root cause or would be fixed by the same change.
Do not pad the review with speculative, cosmetic, or low-value nits just to say something new.
Do not hold back a material issue for a later pass.

`
    : `## Review pass discipline
Assume you may only get one useful review pass for this slice.
Surface the highest-signal issues now.
Batch related issues into one finding when they share a root cause or would be fixed by the same change.
Do not pad the review with speculative, cosmetic, or low-value nits.
Do not hold back a material issue for a later pass.

`
}${buildReviewPreamble(baseSha)}

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

${criteriaCheck}

${planSliceSection}

If all changes are correct and well-structured, respond with exactly: REVIEW_CLEAN`;
};

export const buildDirectReviewPrompt = (
  requestContent: string,
  baseSha: string,
  followUp = false,
): string =>
  `Review the code changed since commit ${baseSha}. Judge the code on its own merits — correctness, types, structure — not just whether it matches a request.

${
  followUp
    ? `## Review pass discipline
This is a follow-up review in the same conversation.
Re-check the concerns you already raised from memory before surfacing anything new.
Only report issues that are still open or genuinely new and material.
Batch related issues into one finding when they share a root cause or would be fixed by the same change.
Do not pad the review with speculative, cosmetic, or low-value nits just to say something new.
Do not hold back a material issue for a later pass.

`
    : `## Review pass discipline
Assume you may only get one useful review pass for this direct request.
Surface the highest-signal issues now.
Batch related issues into one finding when they share a root cause or would be fixed by the same change.
Do not pad the review with speculative, cosmetic, or low-value nits.
Do not hold back a material issue for a later pass.

`
}## What to look for
- Bugs: incorrect runtime behavior, off-by-one, swallowed errors, race conditions
- Type fidelity: runtime values disagreeing with declared types, \`any\`/\`unknown\` as value carriers
- Dead code: new exports with zero consumers introduced by the change
- Structural: duplicated logic, parallel state, mixed concerns introduced by the change
- Names: identifiers that no longer match their scope or purpose after the change
- Enum/value completeness: new variants not handled in all consumers
- Over-engineering: deps bags, wrapper types, or indirection layers that exist "for testability" but add complexity with no real benefit
- Test resilience: new tests that mock the system under test, tests that would pass even if the feature were removed, tests that assert mock call arguments instead of observable outcomes

## What NOT to flag
- Style, formatting, cosmetic preferences
- Test coverage gaps (separate pass handles this)
- Harmless redundancy that aids readability
- Threshold values tuned empirically
- Test style preferences

## Direct request
${requestContent}

If all changes are correct and well-structured, respond with exactly: REVIEW_CLEAN`;

export const buildGapPrompt = (groupContent: string, baseSha: string): string => {
  const criteriaPriority = hasCriteriaSection(groupContent)
    ? `
Prioritise missing regression guards tied to explicit criteria ahead of generic edge-case ideas.
If a criterion can be broken by removing its key implementation line while the tests still pass, report that before narrower hardening suggestions.
`
    : "";

  return `You are a gap-finder for a builder pipeline. A group of slices has just been implemented and reviewed.

Your job is to find **material missing test coverage and materially unguarded reachable behavior** — NOT code style, naming, or architecture.

You are re-checking the SAME group in the SAME conversation unless the orchestrator explicitly reset you for a new group.
First ask whether concerns you already raised are now adequately covered.
Assume this may be the only useful gap pass for this group.
Report only the **highest-signal** gaps that are likely to allow a real regression, plan mismatch, or unguarded reachable behavior to ship.
Batch related variants into one gap when a single representative test or small cluster of tests would cover them.
Do not drip-feed narrower versions of the same underlying issue across multiple passes.
Do not turn one representative missing guard into a sequence of smaller follow-up assertions.
Do not hold back a material finding for later, and do not invent marginal findings just to avoid saying NO_GAPS_FOUND.

${criteriaPriority}

${buildReviewPreamble(baseSha)}

## What to look for
- Behaviours promised by the plan with no meaningful regression guard
- Reachable integration paths between slices with no representative coverage
- Criteria whose key implementation could regress without a test failure
- Public/runtime contract mismatches that tests would not catch
- Only those edge cases a real caller is likely to hit and care about

## What NOT to report
- Code style, formatting, naming — already reviewed
- Architecture suggestions, refactoring ideas — not your job
- Things that are tested adequately — no praise needed
- Pure branch-coverage nits once a representative regression guard already exists
- Multiple variants of the same missing-coverage theme when one bundled finding would cover them
- Low-value hardening ideas that do not materially increase confidence in the shipped behavior
- Alternate-path assertions for behavior that is already meaningfully guarded
- Wiring-only assertions when a representative end-to-end guard already proves the behavior

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

## Prioritisation and batching rules
- Report every genuine gap you find. Do not artificially cap your output, and do not pad with marginal findings.
- Prefer reachable runtime defects, public contract mismatches, missing end-to-end coverage for newly added behavior, and unguarded integration paths over narrow branch-coverage follow-ups.
- If several findings share one root cause or would be solved by the same test cluster, collapse them into one gap.
- If a previous gap was fixed well enough that only smaller variants remain, treat that theme as closed.
- If the remaining issues are only minor hardening or diminishing-return coverage ideas, respond with exactly: NO_GAPS_FOUND

## Group plan
${groupContent}

If you find gaps, list each one as:
- **Gap:** <what's missing>
- **Suggested test:** <one-line description of the test to add>

If everything is well covered, respond with exactly: NO_GAPS_FOUND`;
};

export const buildDirectGapPrompt = (requestContent: string): string =>
  `You are a gap-finder for a direct-mode builder run. A bounded direct request has just been implemented and reviewed.

Your job is to find only material missing test coverage and materially unguarded reachable behavior — NOT code style, naming, or architecture.

You are re-checking the SAME direct request in the SAME conversation unless the orchestrator explicitly reset you.
Assume this may be the only useful gap pass for this direct request.
Report only the highest-signal gaps that are likely to allow a real regression, request mismatch, or unguarded reachable behavior to ship.
Batch related variants into one gap when a single representative test or small cluster of tests would cover them.
Do not drip-feed narrower versions of the same underlying issue across multiple passes.
Do not turn one representative missing guard into a sequence of smaller follow-up assertions.
Do not hold back a material finding for later, and do not invent marginal findings just to avoid saying NO_GAPS_FOUND.

## What to look for
- Behaviours promised by the direct request with no meaningful regression guard
- Reachable runtime paths inside the request with no representative coverage
- Only those edge cases a real caller is likely to hit and care about
- Public/runtime contract mismatches that tests would not catch

## What NOT to report
- Alternate-path or wiring-only assertions when a representative end-to-end guard already proves the behavior
- Pure branch-coverage nits once a representative guard exists
- Low-value hardening ideas that do not materially increase confidence

## Direct request
${requestContent}

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

export const buildDirectFinalPasses = (
  baseSha: string,
  requestContent: string,
): { name: string; prompt: string }[] =>
  buildFinalPasses(baseSha, requestContent).map((pass) => {
    if (pass.name === "Plan completeness") {
      return {
        name: "Request completeness",
        prompt: `You are verifying that the implementation matches the direct request.

Verify the changes since commit ${baseSha} against the direct request below.

## Direct request
${requestContent}

For each requested behavior, verify:
1. Was it implemented?
2. Were the specified edge cases handled?
3. Is there a test for each specified behavior?

Report:
- **Missing:** requested behaviors with no implementation
- **Untested:** behaviors that exist but have no test coverage
- **Divergent:** implementations that differ from the request

If everything matches, respond with exactly: NO_ISSUES_FOUND`,
      };
    }

    return {
      name: pass.name,
      prompt: `${pass.prompt}\n\n## Direct request\n${requestContent}\n\nJudge findings against the direct request, not a plan slice, group, or generated plan artifact.`,
    };
  });
