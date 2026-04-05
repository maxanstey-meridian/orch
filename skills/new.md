# Skill Essence — Distilled Principles by Role

Reference document for writing tier-specific skill prompts (trivial/small/medium/large).
Each `skills/{tier}/{role}.md` draws from this doc and frames it for its tier's intensity.
This doc is not a prompt. It's the shared knowledge base.

---

## Plan

### What the plan agent does

Explores the codebase and produces an implementation plan for a slice/group. Does not write code.

### Universal principles

- Explore before planning. Read real files. Never guess at interfaces, types, or patterns.
- The plan is authoritative over existing code. If existing code contradicts the plan, plan to
  change the code, not preserve it. Unless explicitly stated otherwise, assume greenfield.
- Future-slice wiring stays deferred. Only pull later integration forward if shims would be
  completely pointlessly ceremonious.
- Compatibility/fallback behaviour must be stated in the plan, not invented by the agent.
- Criteria are mandatory. Every slice gets binary acceptance checks that downstream evaluators
  can verify mechanically.

### Enrichment sections (scale with tier)

- `relatedFiles` — paths the builder should read beyond primary files
- `keyContext` — current state of the code (wiring, patterns, gotchas)
- `dependsOn` — prior slice outputs this slice needs
- `testPatterns` — how existing tests work (helpers, mocking patterns, assertion style)
- `signatures` — key type signatures the builder will need
- `gotchas` — non-obvious constraints or traps

Trivial/small tiers use few or none of these. Medium uses what's genuinely non-obvious.
Large uses all that are justified.

### Tier temperature

- **Trivial**: A sentence or two. Don't explore. Don't enrich. Just say what to do.
- **Small**: Brief exploration of the immediate area. Enrichment only if genuinely non-obvious.
- **Medium**: Full exploration of integration points. Enrichment where it saves the builder time.
- **Large**: Full enrichment. All sections justified. Flag ambiguities and risks.

Match the plan's depth to the work. Don't write more plan than the implementation would be.

### Failure modes observed

- Writing more plan than the implementation would be
- Exploring the entire codebase for a one-line change
- Producing "Benefits and Trade-offs" and "Alternatives" sections for trivial work
- Inventing shebang conventions, executable packaging concerns, etc. for a comment edit

---

## Build

### What the builder does

Implements the work, critically evaluates what it built, writes tests, critically evaluates
the tests, commits. No test-first. No RED→GREEN. The test verifies what was built, it doesn't
drive what to build.

### The cycle

1. **Think** — understand what needs doing, read the relevant code
2. **Implement** — write the code
3. **Critique** — step back. Does this actually do what was asked? Did I miss an edge case?
   Did I change something I shouldn't have? Did I drift from the plan?
4. **Test** — write tests that guard the behaviour you just built
5. **Critique** — step back. Would these tests catch it if someone broke the feature? Am I
   testing real behaviour or just exercising code paths? Would deleting the key implementation
   line still leave all tests green?
6. **Run** — actually execute the tests. Read the output. No narrating results.
7. **Commit** — only your files. `git add` specific files, never `git add .`

The self-critique gates are the point. The agent must reflect before moving on, not just
mechanically proceed.

### Tier temperature

- **Trivial**: "Did you do it? Does it work? Move on." Critique is a glance, not an audit.
  Don't psyche yourself out over a comment edit.
- **Small**: "Does this do what was asked? Is the test real?" Brief reflection, not agonising.
- **Medium**: "Did you handle the edge cases? Are your tests guarding real behaviour or just
  covering lines? Did you integrate properly with the existing code?"
- **Large**: "What invariants did you touch? What breaks if this gets called with nil? Did you
  handle every variant of that union? Are there race conditions? Would a future developer
  understand why this works?"

### Universal principles

- Tests are mandatory at every tier. Ceremony is not.
- Test through public interfaces. Describe WHAT the system does, not HOW.
- Mock only at system boundaries (external APIs, databases, time/randomness). Never mock your
  own modules. Fakes over mocks. Real objects over test doubles.
- When criteria exist, each criterion must have at least one regression guard.
- Do not touch files outside your scope. Do not use `git add .` or `git add -A`.
- Actually run the tests. "Tests pass" without Bash execution is a lie.

### Plan authority

The plan describes the INTENT. It is the authority, not the existing code. If the plan says
"filter by X" but existing code does "include everything", change the existing code.

### Fix discipline

When review/completeness/gap feedback identifies a concrete defect, treat it as an implementation
obligation. Don't downgrade findings into "tests only" or TODOs. If you think a finding is wrong,
prove it with code and passing tests. "I did not change implementation code" is not acceptable in
response to an implementation finding.

### Autonomy

The plan slice is the spec — treat it as pre-approved. Don't ask for confirmation on interface
design, test strategy, or approach. Only stop if genuinely blocked.

### Anti-patterns

- Tests that pass regardless of whether the feature works
- Mocking the system under test
- Asserting broken behaviour and calling it "documents the bug"
- Writing more implementation than was asked for (speculative code)
- Narrating test results instead of running them

### Regression guard rule

For every feature: "If someone deleted the key implementation line, would a test fail?"
If no, the test is worthless.

### When tests break

Diagnose before fixing:

- Real regression → fix your code, not the test
- Assumption violation → fix the fragile test
- Conflicting requirements → flag it, proceed with judgement

---

## Verify

### What the verifier does

Runs checks (tests, typecheck, lint) scoped to the diff. Reports what passed and what failed.
Does NOT fix code. Does NOT review code quality. Does NOT editorialise.

### Model weight

Verify is a cheap-model role (haiku/gpt-mini). It runs commands, reads output, and reports
structured JSON. No codebase reasoning required. Save the heavy models for plan, build, review,
and gap where actual judgement is needed.

### Universal principles

- Always run the tests. That is the primary job.
- Run checks in order: tests → typecheck → lint. Stop early if critical failure.
- Scope checks when possible (only changed directories). Full suite if shared code touched.
- Only run commands found in project config. Never invent commands.
- Output must include a machine-readable structured block. Prose-only output is invalid.
- Classify failures into the runtime's required buckets: slice-local, out-of-scope, pre-existing, and runner issues.
- Be fast. Diff, read config, run checks, report. Done.

### Tier temperature

- **Trivial/Small**: Run the scoped tests and typecheck. Report. Nothing more.
- **Medium/Large**: Full suite, typecheck, lint. Report with detail.

All tiers: do not spend time philosophising about whether the change is "meaningful." That's
review's job. Your job is: do the checks pass?

### Ownership contract

The runtime currently expects the verifier to classify failures into ownership buckets. Do that
mechanically from the evidence:

- `sliceLocalFailures` for failures caused by the current execution unit
- `outOfScopeFailures` for unrelated failures
- `preExistingFailures` for failures that already existed before the current changes
- `runnerIssue` for hung runners, crashed tooling, or unstable infrastructure

### Failure modes observed

- Editorialising about whether the test is "meaningful" (that's review's job)
- Philosophising about shebang conventions instead of running checks
- Marking status FAIL but leaving sliceLocalFailures empty for a clearly slice-local defect
- Spending 10 minutes on a 2-file, 5-line change
- Treating code review concerns as verification failures

---

## Review

### What the reviewer does

Judges code quality, correctness, and plan compliance. Checks whether what was built
actually delivers what was asked for.

### Universal principles

- Two-pass priority: data safety and race conditions first. Structural and naming second.
- No hedging. State what's wrong and what the fix is.
- No praise sandwiches. Working code is baseline, not noteworthy.
- Severity is not negotiable. A bug is a bug.
- Read full file contents, not just diffs. Diffs hide context.
- Verify every finding against the current file state before reporting.
- When criteria exist, check each criterion mechanically.

### Tier temperature

- **Trivial**: Is it done? Is it obviously broken? Is it tidy?
- **Small**: Quick quality check. Bugs, type issues, obviously wrong tests.
- **Medium**: Full quality review. All the "what to look for" items below. Deliverable check.
- **Large**: Full review plus cross-cutting concern analysis. Enum completeness tracing.
  Integration boundary verification.

### What to look for

- Bugs: incorrect runtime behaviour, off-by-one, swallowed errors, race conditions
- Type fidelity: runtime values disagreeing with declared types, `any`/`unknown` as carriers
- Dead code: new exports with zero consumers introduced by the change
- Structural: duplicated logic, parallel state, mixed concerns
- Names: identifiers that no longer match their scope after the change
- Enum/value completeness: new variants not handled in all consumers
- Over-engineering: deps bags, wrapper types, or indirection that exist "for testability"
  but add complexity with no real benefit
- Test resilience: tests that mock the SUT, tests that pass even if the feature were removed

### What NOT to flag

- Style, formatting, cosmetic preferences
- Test coverage gaps (separate pass handles this)
- Harmless redundancy that aids readability
- Threshold values tuned empirically
- Missing wiring to call sites that a LATER slice will handle

### Deliverable check (medium/large only)

Would a PM reading the plan slice consider this done?

- If new infrastructure replaces old, are ALL old consumers migrated?
- Is the new code actually reachable from an entry point?
- Are there orphaned setup steps that nothing uses?

### Review pass discipline

- Assume you may only get one useful review pass. Surface highest-signal issues now.
- Batch related issues sharing a root cause into one finding.
- Don't pad with speculative nits. Don't hold back material issues for later.

---

## Gap

### What the gap finder does

Identifies missing test coverage and unhandled edge cases. Last line of defence.

### Tier temperature

- **Trivial/Small**: Skip. The review and verify passes are sufficient.
- **Medium**: Run once at end of group. Focus on regression guards for criteria.
- **Large**: Run per group. Full coverage analysis. Test resilience check.

### Universal principles

- Find missing coverage. Do NOT flag style, naming, or architecture.
- If coverage is adequate, say so. Don't invent marginal findings.
- Report highest-signal gaps only. Batch related variants.
- When criteria exist, prioritise missing regression guards for criteria.
- Report every genuine gap you find. Do not artificially cap your output, and do not pad with marginal findings.

### What to look for

- Untested edge cases and boundary conditions
- Combinations of features with no test coverage
- Integration paths between components with no coverage
- Off-by-one, empty inputs, null inputs
- Behaviours described in the plan with no corresponding test
- Tests that would still pass if the feature were removed

### What NOT to report

- Code style, formatting, naming
- Architecture suggestions
- Things already tested adequately
- Pure branch-coverage nits when a representative guard exists
- Multiple variants of the same theme (bundle them)
- Low-value hardening ideas

### Classify findings

- **COVERAGE GAP**: code works, lacks test coverage. Add tests only.
- **BUG**: code produces wrong output. Fix code AND add a test. Never enshrine broken
  behaviour as a passing assertion.

---

## Cross-cutting principles

### Proportionality

Match effort to complexity. Triage classifies the tier once. Every agent spawn pulls the
prompt for its role + tier. A trivial task gets trivial prompts across all roles.

### The plan is the contract

The plan describes intent. It is authoritative. Existing code that contradicts the plan
gets changed. The plan's specified approach IS the requirement.

### Evaluators don't classify their own findings

Evaluators find problems. A separate triage pass classifies ownership and routing.
The finder should not be the judge.

### Fail closed

When structured output is missing, malformed, or contradictory, treat it as a failure
requiring attention. Don't silently skip. An empty failures array with status FAIL means
"classification failed" not "nothing to fix."

### Tests prove things work, not that things were called

Fakes over mocks. Real objects over test doubles. Test observable outcomes, not internal
delegation.

### Context resets beat context accumulation

By slice 4 the agent has 3 slices of stale context. Structured handoffs (what was built,
current test state, criteria for this slice) outperform conversation history.

### Technology context is orthogonal

A `nestjs.md`, `dotnet.md`, `laravel.md` gets appended based on project detection.
The tier picks the depth. The technology context picks the domain knowledge. They compose.
