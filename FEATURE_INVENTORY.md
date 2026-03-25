# Feature Inventory & PRDs: TDD Orchestrator

## Feature Inventory

*Features 1–13 implemented. See git history for original PRDs.*

| #  | Feature                                      | Purpose                                                                                                                                                                                                                                                         | Dependencies                      | Consumers                    |
|----|----------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------|------------------------------|
| 14 | Project Initialisation (Init Mode)           | Interactive bootstrap for fresh repositories: gathers context about stack, coding style, linting, and external references through operator dialogue, producing a project profile that informs all subsequent agent prompts — without scaffolding files directly | 3                                 | 13, 15                       |
| 15 | Plan Generation (Plan Mode)                  | Takes a feature inventory document and produces a structured group-and-slice plan, replacing the current workflow where plans are authored externally                                                                                                           | 14                                | 1, 13                        |
| 16 | Review Minimum-Change Threshold              | Defers review cycles until the cumulative changes from implementation cross a size threshold, preventing review agents from being invoked on trivially small diffs                                                                                              | 4                                 | 10                           |
| 17 | Repository Prerequisite Check                | Validates that the working directory is a version-controlled repository before any orchestration begins, failing fast with a clear message instead of crashing mid-run                                                                                          | —                                 | 13                           |
| 18 | Credit Exhaustion Detection                  | Detects when the underlying agent runtime has exhausted its usage allowance and distinguishes this from a successful completion, preventing the orchestrator from treating a credit-starved agent as having finished its work                                   | —                                 | 7, 13                        |
| 19 | Operator Interrupt and Guidance              | Allows the operator to interrupt a running agent mid-execution, inject guidance, and resume — with the agent aware it is still operating within an orchestrated context rather than a freeform session                                                          | 7, 8                              | 10, 13                       |
| 20 | Persistent Status Line (HUD)                 | Renders a fixed bottom-of-terminal status bar showing real-time orchestration progress: current slice, group progress, elapsed time, usage budget remaining, and active agent activity                                                                          | 2, 4, 18                          | 13                           |
| 21 | State Schema Validation (Zod)                | Validates the persisted orchestrator state using Zod on load, rejecting corrupt or structurally invalid state files rather than propagating bad data                                                                                             | —                                 | 2                            |
| 22 | Lint and Format Gate (oxlint + oxfmt)        | Runs oxlint and oxfmt as a quality gate alongside or independent of the test gate, ensuring agent-produced code meets style standards before review                                                                                | 3                                 | 10, 11, 12, 13               |

## Cross-Cutting Concern: Prompt Construction Discipline

Every prompt the orchestrator constructs for an agent follows a strict structure:

1. **Skill invocation (mandatory, first line):** A skill reference (e.g., the TDD skill for implementation agents, the
   deep-review skill for review agents) that defines the agent's methodology, discipline, and working process. This is
   non-negotiable — it is the behavioural contract.

2. **Contextual data (remainder of prompt):** Plan slice content, review findings, commit references, codebase brief.
   This section provides *scope and inputs* — what to work on, what to look at, what changed. It shall never contain
   procedural instructions that compete with or override the skill's methodology.

**The invariant:** No text in the contextual data section shall instruct the agent *how* to work. Phrases like "fix all
issues", "run tests after each change", "commit when done" are methodology directives that belong in the skill
definition, not in the orchestrator's prompt. The orchestrator tells the agent *what* — the skill tells the agent *how*.

This applies to all prompt construction across the system:

- **Initial implementation prompts** (PRD 10): Skill invocation + plan slice content. No "implement using
  red-green-refactor" — that's the skill's job.
- **Fix prompts after review feedback** (PRDs 10, 11, 12): Skill invocation + plan slice content + review findings
  section. No "fix all issues and run tests" — the skill already defines the fix workflow.
- **Gap fix prompts** (PRD 11): Skill invocation + group content + gap findings. The scope constraint ("add tests only,
  do not refactor") is legitimate scoping data — it limits *what* to change, not *how* to change it.
- **Review prompts** (PRDs 10, 11, 12): Review skill invocation + commit reference + plan slice content. The review
  skill defines the review methodology.
- **Gap analysis prompts** (PRD 11): The gap agent's scope constraints (what to look for, what not to report) are
  legitimate scoping data — they define the review's focus area, not its methodology.
- **Final audit prompts** (PRD 12): Audit scope description + commit reference + plan content. The audit focus areas are
  scoping data.

If a skill's methodology needs to change (e.g., the TDD skill should handle fix-mode differently), that change belongs
in the skill definition — not in the orchestrator's prompt overriding the skill.

---

### PRD 14: Project Initialisation (Init Mode)

#### Purpose

Provides an interactive bootstrap experience for fresh or minimal repositories. Instead of fingerprinting an empty
directory (which yields nothing useful), the orchestrator enters a dialogue with the operator to gather the foundational
context that all downstream agents need: what stack, what conventions, what tools, what external resources exist. The
resulting profile feeds into brief generation and agent prompts, so that even the first implementation slice produces
code that feels native to the project's intended style.

This is also useful for throwaway/scripting projects where the operator wants readable, styled output from the first
commit without formal project setup.

#### Functional Requirements

1. The system shall detect when the working directory has insufficient project markers (no manifest files, no source
   directories, no prior brief) and suggest init mode.
2. The system shall accept an explicit flag to enter init mode regardless of directory state.
3. In init mode, the system shall interactively prompt the operator for:
    - Primary language and framework
    - Coding style preferences (naming, architecture patterns, formatting)
    - Linting and formatting tools to be used
    - Paths to other directories or files that provide context (e.g., a monorepo sibling, a style guide, an existing
      CLAUDE.md)
    - Any other context the operator wants agents to know
4. The system shall produce a project profile from the gathered context — the same profile shape that fingerprinting
   produces, augmented with the operator's stated preferences.
5. The system shall NOT scaffold files, create directories, or write boilerplate. The profile is informational context
   only. The implementation agent's first slice naturally produces the project structure.
6. Init mode shall be composable with plan mode — the operator may init and then immediately generate a plan in the same
   invocation.

#### Inputs and Outputs

- **Input:** Operator responses to interactive prompts; optionally, paths to external reference material.
- **Output:** A project profile (same shape as fingerprinting output) written to the brief location and/or state, ready
  for injection into agent prompts.

#### Interaction Model

- Invoked by the orchestration controller before any group processing begins.
- Produces output consumed by codebase fingerprinting (as a seed/override) and by the agent execution engine (via prompt
  injection).
- If init has already been run, fingerprinting may merge the init profile with its own detection results, with
  operator-stated preferences taking priority.

#### Behavioural Rules

1. Init mode is mutually exclusive with resume — you cannot resume a prior run and also init.
2. If the operator exits init early (ctrl+c), no partial profile is persisted.
3. Questions should be ordered from most impactful to least — stack and style first, nice-to-haves last.
4. The system should offer sensible defaults where possible so the operator can skip through quickly.

#### Modes and Configuration

- Explicit flag to force init mode.
- Implicit suggestion when the directory appears empty/minimal.
- Optional combination with plan generation in the same invocation.

#### Error Handling and Degradation

- If the operator provides no answers at all (enters through everything), the system falls back to fingerprinting-only
  behaviour — no profile is generated from init.
- If referenced external paths don't exist, warn and skip them rather than failing.

---

### PRD 15: Plan Generation (Plan Mode)

#### Purpose

Transforms a feature inventory document into a structured group-and-slice plan, automating the step that is currently
done manually. This replaces the current workflow where `--plan` expects an already-structured plan file. After this
feature, `--plan` takes the raw inventory and produces the plan; resuming a run uses the generated plan.

#### Functional Requirements

1. The system shall accept a feature inventory document (the structured output of the feature inventory skill) as input.
2. The system shall invoke an agent to analyse the inventory and produce a group-and-slice plan following the
   orchestrator's expected plan format: named groups containing numbered slices with titles and body content.
3. The generated plan shall respect dependency ordering — slices that depend on other slices appear later.
4. The generated plan shall group related features into named groups for logical batching.
5. The system shall write the generated plan to a well-known location and then proceed to orchestrate it (or exit if the
   operator wants to review first).
6. The plan generation agent shall receive the project profile/brief as context so that grouping and slicing decisions
   are informed by the project's stack and architecture.

#### Inputs and Outputs

- **Input:** A feature inventory document (markdown with structured feature entries and PRDs).
- **Output:** A plan document in the orchestrator's expected format (groups with slices), written to disk.

#### Interaction Model

- Invoked by the orchestration controller when the plan flag points to an inventory-format document.
- The generated plan is then consumed by the plan parser (Feature 1) as if it were a hand-written plan.
- May optionally compose with init mode (Feature 14) if both flags are provided.

#### Behavioural Rules

1. The current `--plan` flag semantics change: it now means "generate a plan from this inventory." A new `--resume`
   flag (or implicit detection of an existing plan) handles the "continue an already-generated plan" case.
2. If a plan already exists for the given inventory, the system should ask the operator whether to regenerate or resume.
3. Slice granularity should avoid producing trivially small slices that would waste review cycles (see Feature 16).

#### Modes and Configuration

- Plan-only mode: generate the plan and stop, allowing operator review before orchestration.
- Plan-and-run mode: generate and immediately begin orchestration.

#### Error Handling and Degradation

- If the inventory document is malformed or empty, fail with a clear message before invoking the agent.
- If plan generation produces an empty or unparseable plan, report the failure rather than proceeding with no slices.

---

### PRD 16: Review Minimum-Change Threshold

#### Purpose

Prevents review agents from being invoked on trivially small changes. When a slice produces only a few lines of code
across one or two files, a full review cycle is wasteful — the review agent has too little to meaningfully evaluate, and
the overhead of extraction and follow-up burns time and credits. This feature gates review entry on a minimum cumulative
change size.

#### Functional Requirements

1. The system shall measure the cumulative size of changes since the review baseline (e.g., lines added + lines removed,
   or total diff character count).
2. If the cumulative change is below a configurable threshold, the review cycle shall be skipped entirely for that
   slice.
3. When review is deferred due to threshold, the commit for that slice shall also be deferred — changes accumulate
   across slices until the threshold is met.
4. When the threshold is eventually met (possibly spanning multiple slices), the review covers all accumulated changes.
5. The threshold shall have a sensible default that prevents reviewing diffs under ~30 changed lines.

#### Inputs and Outputs

- **Input:** The git diff between the review baseline and current HEAD.
- **Output:** A boolean decision: review now or defer.

#### Interaction Model

- Sits between the implementation agent's completion and the review cycle entry in the slice processing pipeline (
  Feature 10).
- Consumes change detection (Feature 4) to measure diff size.
- When deferring, the review baseline is NOT advanced — it carries forward so the next threshold check sees the
  cumulative diff.

#### Behavioural Rules

1. The threshold applies to the initial review gate only — once a review cycle has started (e.g., cycle 2 after review
   feedback), it completes regardless of diff size.
2. The final review passes (Feature 12) are exempt from this threshold — they always run if there are any changes at
   all.
3. If a group ends with deferred reviews, the gap analysis pass should still run against all changes.

#### Modes and Configuration

- Configurable threshold (line count or similar metric).
- An override flag to force review on every slice regardless of size (the "atomic" mode).

#### Error Handling and Degradation

- If diff measurement fails (e.g., git error), default to running the review rather than skipping it.

---

### PRD 17: Repository Prerequisite Check

#### Purpose

Validates that the working directory is a git repository before any orchestration begins. The orchestrator depends
heavily on version control for change detection, commit references, and diff-based review. Without a repository, these
operations fail with confusing errors mid-run. This feature fails fast with a clear, actionable message.

#### Functional Requirements

1. The system shall check for the presence of a version control repository in the working directory at startup, before
   any agent invocation or state loading.
2. If no repository is found, the system shall exit with a clear error message explaining the requirement.
3. The check shall also verify that the repository has at least one commit (an initialised but empty repository is
   insufficient for commit-reference operations).

#### Inputs and Outputs

- **Input:** The working directory path.
- **Output:** Pass (continue) or fail (exit with message).

#### Interaction Model

- Invoked by the orchestration controller (Feature 13) as the first validation step, before state loading or
  fingerprinting.

#### Behavioural Rules

1. This check runs unconditionally — it cannot be skipped or overridden.
2. The error message should suggest `git init && git commit --allow-empty -m "init"` or equivalent to help the operator
   recover.

#### Modes and Configuration

None. This is a hard prerequisite.

#### Error Handling and Degradation

Not applicable — this feature IS the error handling for the missing-repository case.

---

### PRD 18: Credit Exhaustion Detection

#### Purpose

Detects when the underlying agent runtime has run out of its usage allowance (rate limit, credit cap, subscription
ceiling) and distinguishes this from a successful or failed completion. Without this, a credit-exhausted agent returns
empty or truncated output that the orchestrator misinterprets as "agent finished with no changes" — silently skipping
the slice.

#### Functional Requirements

1. The system shall detect credit/usage exhaustion from agent process output, exit codes, or error streams.
2. When exhaustion is detected, the system shall clearly log that the agent was credit-starved, not that it completed
   successfully.
3. The system shall pause orchestration and inform the operator, rather than continuing to the next slice.
4. The system shall persist enough state that the operator can resume cleanly after credits replenish.
5. If usage information is available (remaining balance, reset time), the system should surface it in the pause message.

#### Inputs and Outputs

- **Input:** Agent process exit code, stdout, stderr.
- **Output:** A credit-exhaustion signal that interrupts the normal slice processing flow.

#### Interaction Model

- Integrated into the agent execution engine (Feature 7) as a post-execution check.
- Surfaces to the orchestration controller (Feature 13) as a distinct failure mode, separate from agent error or agent
  success.
- Feeds into the status line (Feature 20) if available, showing remaining usage.

#### Behavioural Rules

1. Credit exhaustion is NOT an agent failure — it should not count against retry limits or be logged as an error.
2. The system should distinguish between "agent hit the limit mid-response" (partial output, needs re-run) and "agent
   was rejected before starting" (no output, clean retry).
3. On resume after credit replenishment, the interrupted slice should be re-run from the appropriate point (re-run TDD
   if mid-implementation, re-run review if mid-review).

#### Modes and Configuration

- Optional automatic wait-and-retry mode: if the reset time is known and short, the system could wait and retry
  automatically instead of pausing.

#### Error Handling and Degradation

- If the system cannot determine whether a failure is credit-related or a genuine error, it should surface both
  possibilities to the operator rather than guessing.

---

### PRD 19: Operator Interrupt and Guidance

#### Purpose

Allows the operator to interrupt a running agent mid-execution, provide guidance or corrections, and resume — with the
agent maintaining awareness that it is operating within an orchestrated workflow. Currently, the only interaction point
is the question-detection follow-up (Feature 8). This feature extends that to operator-initiated interrupts at any time.

#### Functional Requirements

1. The system shall accept operator input while an agent is actively running (not just at the end of an agent turn).
2. Operator input shall be relayed to the running agent as a message in its session context.
3. The relayed message shall include framing that tells the agent it is still under orchestration — the guidance is a
   course correction, not a switch to freeform mode.
4. After processing the guidance, the agent shall continue working on its current slice/task, incorporating the
   guidance.
5. The system shall support a "pause" action that suspends the agent and lets the operator inspect output before
   deciding whether to continue, redirect, or abort.

#### Inputs and Outputs

- **Input:** Operator keystrokes/commands captured during agent execution.
- **Output:** Messages injected into the active agent session; possibly a pause/resume signal to the agent process.

#### Interaction Model

- Extends the agent execution engine (Feature 7) with an input channel that is active during execution, not just
  post-execution.
- Extends interactive follow-up (Feature 8) from reactive (agent asks) to proactive (operator interrupts).
- The orchestration controller (Feature 13) may need to handle the case where guidance changes the agent's output shape.

#### Behavioural Rules

1. Interrupt delivery should be as immediate as possible — the agent should receive the message at the next natural
   processing boundary.
2. The orchestration framing in the relayed message should be consistent and non-overridable by the operator's text —
   the agent must always know it's orchestrated.
3. If the operator aborts via interrupt, the system should treat this like a ctrl+c: persist state for resume, do not
   mark the slice as complete.
4. Multiple interrupts during a single agent run are allowed — each is delivered in order.

#### Modes and Configuration

- Interrupt key binding (default: a key that doesn't conflict with ctrl+c which kills the process).
- Option to disable interrupts for fully autonomous runs.

#### Error Handling and Degradation

- If message delivery to the agent fails (process crashed, session expired), inform the operator and offer to restart
  the agent with the guidance as initial context.
- In non-interactive environments (piped input, CI), interrupt mode is disabled automatically.

---

### PRD 20: Persistent Status Line (HUD)

#### Purpose

Renders a persistent, auto-updating status bar fixed to the bottom of the terminal, giving the operator at-a-glance
visibility into orchestration progress without scrolling through log output. This replaces the current "read the log
stream and figure out where we are" experience.

#### Functional Requirements

1. The system shall reserve the last row of the terminal for a status bar that persists across all log output.
2. The status bar shall display:
    - **Current slice identifier** and total slice count (e.g., `S4/13`).
    - **Group progress** as a visual progress bar (slices completed in current group vs total in group).
    - **Elapsed time** since orchestrator start.
    - **Usage budget**: percentage of agent runtime usage remaining and the time at which it resets.
    - **Active agent**: which bot is currently running and a one-line summary of its current activity (derived from the
      most recent log line from that agent).
3. All log output from agents and the orchestrator shall scroll above the status bar without overwriting it.
4. The status bar shall update on every state change (new slice, new cycle, agent switch) and on a periodic interval for
   the elapsed-time clock.
5. The status bar shall adapt to terminal width — truncating or collapsing fields gracefully when the terminal is
   narrow.

#### Inputs and Outputs

- **Input:** Orchestrator state (current slice, group, elapsed time), agent activity (last output line), usage data from
  the runtime.
- **Output:** Terminal escape sequences that render and maintain the status bar.

#### Interaction Model

- Consumes orchestrator state persistence (Feature 2) for slice/group progress.
- Consumes change detection (Feature 4) indirectly — state changes that trigger status updates.
- Consumes credit exhaustion detection (Feature 18) for the usage budget display.
- The orchestration controller (Feature 13) initialises the status line at startup and tears it down on exit.
- The existing log function must be wrapped to account for the reserved bottom row.

#### Behavioural Rules

1. The status bar must not interfere with agent output streaming — log lines must appear above the bar in real time.
2. On terminal resize, the status bar must reposition to the new bottom row.
3. On orchestrator exit (clean or interrupted), the status bar must be cleared and the terminal restored to normal
   scrolling.
4. If the terminal does not support ANSI escape sequences (piped output, dumb terminal), the status bar is disabled
   silently.
5. The usage budget field shows "unknown" if usage data is not available, rather than being omitted.

#### Modes and Configuration

- A flag to disable the status bar (for piped/logged output or operator preference).
- Refresh interval for the time display (default: every second while an agent is active).

#### Error Handling and Degradation

- If terminal dimension detection fails, disable the status bar and fall back to inline logging.
- If usage data cannot be retrieved, display the usage field as "—" rather than omitting it.

---

### PRD 21: State Schema Validation (Zod)

#### Purpose

Validates the persisted orchestrator state file using Zod on load. State files can become corrupt (
partial writes from interrupted processes, manual edits, version mismatches between orchestrator updates). Without
validation, bad data propagates silently and causes confusing failures downstream.

#### Functional Requirements

1. The system shall define a Zod schema for the orchestrator state structure, covering all fields, their types, and which
   are required vs optional.
2. On state load, the system shall validate the loaded data against this Zod schema.
3. If validation fails, the system shall report which fields are invalid and exit with a clear error, rather than
   proceeding with corrupt state.
4. The Zod schema shall be the single source of truth for the state structure — the TypeScript type used in code should be
   inferred from the schema (`z.infer<typeof stateSchema>`).

#### Inputs and Outputs

- **Input:** Raw parsed content of the state file.
- **Output:** A validated, typed state object — or a validation error with details.

#### Interaction Model

- Invoked by orchestrator state persistence (Feature 2) on every load operation.
- The validated output is consumed by all features that depend on state (Features 7, 8, 10, 11, 12, 13).

#### Behavioural Rules

1. Unknown fields in the state file are ignored (forward compatibility — a newer orchestrator version may have added
   fields).
2. Missing optional fields are filled with defaults, not treated as errors.
3. Type mismatches (e.g., string where number expected) are always errors.
4. The state file path is included in error messages so the operator knows which file to inspect or delete.

#### Modes and Configuration

None — validation is always active.

#### Error Handling and Degradation

- On validation failure, the error message should suggest deleting the state file to start fresh, since a corrupt state
  is rarely recoverable.
- A `--reset` flag on the orchestrator should allow the operator to explicitly discard state and start clean.

---

### PRD 22: Lint and Format Gate (oxlint + oxfmt)

#### Purpose

Runs oxlint and oxfmt as a quality gate, ensuring agent-produced code meets style standards. Currently only the test
suite is gated. This extends the quality gate to include linting (oxlint) and formatting (oxfmt), which are separate
concerns — tests verify behaviour, linting verifies correctness patterns, formatting verifies style.

#### Functional Requirements

1. The system shall run oxlint and oxfmt after implementation and review fix cycles, alongside or as part of the test
   gate.
2. Lint/format failures shall be treated similarly to test failures — logged clearly, and the agent is given the
   opportunity to fix them.
3. oxfmt shall be run in fix mode (auto-correct) first — only gate on oxlint output that requires manual intervention.
4. If oxlint/oxfmt are not installed, this gate is silently skipped (same as the test gate when no test runner is found).

#### Inputs and Outputs

- **Input:** The current working directory.
- **Output:** Pass/fail signal, plus formatted error output for agent consumption on failure.

#### Interaction Model

- Sits alongside the test gate (Feature 5) in the slice processing pipeline (Feature 10), gap analysis (Feature 11), and
  final review passes (Feature 12).
- On failure, error output is fed to the implementation agent as fix instructions, similar to how test failures are
  handled.

#### Behavioural Rules

1. oxfmt runs in fix mode first — only report failures that oxfmt couldn't resolve automatically.
2. Lint gates run after the test gate, not before — behavioural correctness takes priority over style.
3. Lint failures should not block the review cycle — the review agent should see the code as-is, and lint fixes happen
   after review.

#### Modes and Configuration

- A flag to disable the lint gate entirely.
- Separate thresholds for oxlint errors (block) vs warnings (log but continue).

#### Error Handling and Degradation

- If oxlint/oxfmt are not installed or fail to execute, warn and skip rather than blocking the pipeline.
- If oxfmt auto-fix changes files, those changes should be committed as part of the current slice's work, not left as
  uncommitted modifications.

---

