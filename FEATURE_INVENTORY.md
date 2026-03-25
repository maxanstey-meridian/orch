# Feature Inventory & PRDs: TDD Orchestrator

## Feature Inventory

| # | Feature | Purpose | Dependencies | Consumers |
|---|---------|---------|-------------|-----------|
| 1 | Plan Parsing | Reads a structured plan document and extracts a hierarchy of groups containing ordered slices, each with a numeric identifier, title, and body content | — | 10, 13 |
| 2 | Orchestrator State Persistence | Saves and restores orchestration progress (active session identifiers for each agent role, last completed slice) so the system can resume after interruption | — | 7, 8, 10, 11, 12, 13 |
| 3 | Codebase Fingerprinting and Brief Generation | Examines the working directory to produce a codebase summary AND a project profile (detected stack, test command, conventions) for use by the orchestrator and agents | — | 5, 7, 10, 11, 12, 13 |
| 4 | Version Control Change Detection | Captures commit references and detects whether the repository has changed (new commits or uncommitted work) relative to a known reference point | — | 10, 11, 12, 13 |
| 5 | Test Gate | Executes the project's test suite — discovered from the project profile emitted by fingerprinting — and reports pass/fail as a quality gate between phases | 3 | 10, 11, 12, 13 |
| 6 | Question Detection | Analyses the trailing portion of agent output text to determine whether the agent is asking the operator a question and awaiting a response | — | 7 |
| 7 | Agent Execution Engine | Spawns a sub-agent process with session management, streams and formats output in real time, captures the full assistant text for downstream handoff, and returns structured results including exit code and question flag | 6 | 8, 9, 10, 11, 12 |
| 8 | Interactive Follow-Up | When an agent asks a question during execution, prompts the human operator for a response and relays it back into the same agent session | 7 | 10 |
| 9 | Review Findings Extraction | Retrieves the substantive content of a completed agent session as structured text for handoff to another agent, without requiring a second "repeat yourself" round-trip | 7 | 10, 11, 12 |
| 10 | Slice Processing Pipeline | For each slice in a group, runs the implementation agent, validates with tests, then enters a bounded review-fix cycle; classifies fix-agent outcomes as deliberate rejection vs execution failure | 1, 2, 3, 4, 5, 7, 8, 9 | 13 |
| 11 | Gap Analysis Pass | After all slices in a group, runs a dedicated agent to find missing test coverage across the group's combined changes, then feeds gaps through implementation and review | 2, 3, 4, 5, 7, 9 | 13 |
| 12 | Final Review Passes | After all groups, runs a sequence of stack-aware audit agents across the entire run's changes, feeding findings through the implementation-review cycle | 2, 3, 4, 5, 7, 9 | 13 |
| 13 | Orchestration Controller | Top-level coordinator: parses arguments, initialises state/brief/profile, iterates groups with resume/filter/compaction, runs final passes, handles interactive vs automatic mode | 1, 2, 3, 4, 5, 10, 11, 12 | — |

## Cross-Cutting Concern: Prompt Construction Discipline

Every prompt the orchestrator constructs for an agent follows a strict structure:

1. **Skill invocation (mandatory, first line):** A skill reference (e.g., the TDD skill for implementation agents, the deep-review skill for review agents) that defines the agent's methodology, discipline, and working process. This is non-negotiable — it is the behavioural contract.

2. **Contextual data (remainder of prompt):** Plan slice content, review findings, commit references, codebase brief. This section provides *scope and inputs* — what to work on, what to look at, what changed. It shall never contain procedural instructions that compete with or override the skill's methodology.

**The invariant:** No text in the contextual data section shall instruct the agent *how* to work. Phrases like "fix all issues", "run tests after each change", "commit when done" are methodology directives that belong in the skill definition, not in the orchestrator's prompt. The orchestrator tells the agent *what* — the skill tells the agent *how*.

This applies to all prompt construction across the system:

- **Initial implementation prompts** (PRD 10): Skill invocation + plan slice content. No "implement using red-green-refactor" — that's the skill's job.
- **Fix prompts after review feedback** (PRDs 10, 11, 12): Skill invocation + plan slice content + review findings section. No "fix all issues and run tests" — the skill already defines the fix workflow.
- **Gap fix prompts** (PRD 11): Skill invocation + group content + gap findings. The scope constraint ("add tests only, do not refactor") is legitimate scoping data — it limits *what* to change, not *how* to change it.
- **Review prompts** (PRDs 10, 11, 12): Review skill invocation + commit reference + plan slice content. The review skill defines the review methodology.
- **Gap analysis prompts** (PRD 11): The gap agent's scope constraints (what to look for, what not to report) are legitimate scoping data — they define the review's focus area, not its methodology.
- **Final audit prompts** (PRD 12): Audit scope description + commit reference + plan content. The audit focus areas are scoping data.

If a skill's methodology needs to change (e.g., the TDD skill should handle fix-mode differently), that change belongs in the skill definition — not in the orchestrator's prompt overriding the skill.

---

## Group Plan

## Group: Foundation — Pure Parsers

### Slice 1: Plan Parsing

#### Purpose
Transforms a structured plan document into a programmatic representation of groups and slices. The plan document is the single source of truth for what the orchestrator will build, in what order, and how work is divided.

#### Functional Requirements
- The system shall read a plan document from a file path
- The system shall recognise group boundaries marked by second-level headings containing a "Group:" prefix followed by a group name
- The system shall recognise slice boundaries marked by third-level headings containing either "Slice" or "Phase" followed by a numeric identifier and an optional title
- The system shall capture the full body content of each slice (all lines between one slice heading and the next slice or group heading)
- The system shall associate each slice with its parent group
- The system shall preserve the ordering of groups and slices as they appear in the document
- The system shall extract the numeric identifier and title from each slice heading
- If a slice heading has no title text after the number, the system shall generate a default title using the slice number
- The system shall return an empty result if no groups are found, and the caller shall treat this as an error condition

#### Inputs and Outputs
- **Input:** A file path pointing to a plan document
- **Output:** An ordered list of groups, where each group has a name (string) and an ordered list of slices. Each slice has a numeric identifier (integer), a title (string), and a content body (string containing all text under that slice heading).

#### Interaction Model
- Consumed by: Orchestration Controller (to determine execution order), Slice Processing Pipeline (slice content passed to agents), Gap Analysis Pass (group content aggregated), Final Review Passes (full plan content)
- This feature has no dependencies on other features

#### Behavioural Rules
- Groups must appear before any slices they contain
- A slice is always associated with the most recently encountered group
- Content accumulates line-by-line until the next heading boundary
- Trailing whitespace on content bodies is stripped
- The slice heading line itself is included in the slice content body
- Slice numbers are expected to be globally unique and monotonically increasing across the entire plan — the resume mechanism depends on comparing slice numbers across groups

#### Modes and Configuration
- None. Parsing behaviour is fixed.

#### Error Handling and Degradation
- If the file does not exist, the system shall report the error and terminate
- If no groups are found in a valid file, the system shall report an error and terminate
- Malformed headings (e.g., missing "Group:" prefix or missing slice number) are silently ignored — they become part of the preceding slice's content body

---

### Slice 2: Question Detection

#### Purpose
Determines whether an agent's output ends with a question or request for input, enabling the orchestrator to pause and involve the human operator rather than proceeding blindly when the agent is uncertain.

#### Functional Requirements
- The system shall analyse the trailing portion (last ~500 characters) of an agent's text output
- The system shall detect questions by:
  - Trailing question marks (ignoring trailing whitespace and code formatting characters)
  - Common conversational patterns that indicate the agent is soliciting input (e.g., "what do you think", "should I/we", "want me to", "before I proceed", "any thoughts/feedback/preferences", "let me know", "how would you like")
- The system shall return a boolean indicating whether a question was detected

#### Inputs and Outputs
- **Input:** A string of agent output text
- **Output:** Boolean — whether the text appears to end with a question

#### Interaction Model
- Called by: Agent Execution Engine (after agent process completes, to set the `needsInput` flag on the result)
- Consumed by: Interactive Follow-Up (uses the `needsInput` flag to decide whether to prompt the operator)

#### Behavioural Rules
- Only the tail of the output is examined — questions early in the output that were followed by substantive work are not flagged
- Pattern matching is case-insensitive
- An empty or null input returns false (no question)

#### Modes and Configuration
- The set of question-detection patterns is fixed
- The tail length examined is fixed (~500 characters)

#### Error Handling and Degradation
- False positives (detecting a question when there isn't one) cause an unnecessary operator prompt — low cost
- False negatives (missing a real question) cause the orchestrator to proceed without operator input — the agent will likely re-ask or make its own decision

---

### Slice 3: Orchestrator State Persistence

#### Purpose
Enables the orchestrator to survive interruptions (crashes, manual stops, timeouts) and resume from where it left off. Tracks which agent sessions are active and which work units have been completed.

#### Functional Requirements
- The system shall persist state to a well-known file location in the working directory
- The system shall store the following state fields:
  - Session identifier for the implementation agent (optional — absent before first run)
  - Session identifier for the review agent (optional)
  - Session identifier for the gap analysis agent (optional)
  - Numeric identifier of the last fully completed slice (optional)
- The system shall load state from the file on startup, returning empty/default state if the file does not exist or is corrupt
- The system shall update state after each significant progress milestone (agent session established, slice completed, group completed)
- The system shall delete the state file when the entire orchestration run completes successfully

#### Inputs and Outputs
- **Input (load):** None (reads from well-known file path)
- **Output (load):** State record with optional fields as described above
- **Input (save):** State record to persist
- **Output (save):** Side effect — file written to disk

#### Interaction Model
- Written by: Slice Processing Pipeline, Gap Analysis Pass, Agent Execution Engine (indirectly via callers), Orchestration Controller
- Read by: Orchestration Controller (on startup), Slice Processing Pipeline (to skip completed slices, to reuse sessions)

#### Behavioural Rules
- State is persisted after every mutation, not batched
- On load failure (missing file, parse error), the system starts with empty state — it does not fail
- Session identifiers, once established, persist across slices within the same run to enable session resumption
- The last-completed-slice marker is used to skip already-completed slices on resume
- The last-completed-slice comparison assumes globally unique, monotonically increasing slice numbers across all groups

#### Modes and Configuration
- The state file path is a configuration constant

#### Error Handling and Degradation
- Corrupt or missing state file: treated as fresh start (no error)
- State file deletion failure at end of run: silently ignored

---

## Group: Foundation — Infrastructure

### Slice 4: Version Control Change Detection

#### Purpose
Provides the ability to capture a point-in-time reference to the repository state and later determine whether anything has changed since that reference. This is used throughout the orchestration to decide whether review passes are needed and whether agents produced meaningful work.

#### Functional Requirements
- The system shall capture the current commit reference of the repository
- The system shall detect uncommitted changes in the working tree
- The system shall determine whether the repository has changed since a given reference point, considering both new commits and uncommitted modifications
- The system shall provide the current working tree status as a human-readable summary

#### Inputs and Outputs
- **Input (capture):** None (reads from repository)
- **Output (capture):** A commit reference string
- **Input (change detection):** A previously captured commit reference
- **Output (change detection):** Boolean — whether changes exist since the reference
- **Output (status):** A string summarising the current working tree state

#### Interaction Model
- Consumed by: Slice Processing Pipeline (to decide if review is needed), Gap Analysis Pass (to scope the diff), Final Review Passes (to scope the diff), Orchestration Controller (to decide if final passes are needed)

#### Behavioural Rules
- A change is detected if either the current commit differs from the reference OR there are uncommitted modifications
- Commit references are opaque strings — consumers compare them for equality only

#### Modes and Configuration
- None

#### Error Handling and Degradation
- If the working directory is not a repository, the underlying commands will fail. This is a precondition — the system does not handle this gracefully.

---

### Slice 5: Codebase Fingerprinting and Brief Generation

#### Purpose
Examines the working directory to produce two outputs: (1) a codebase summary brief for injection into agent prompts, giving agents contextual awareness without requiring exploration; and (2) a project profile that tells the orchestrator how to interact with this specific project — critically, how to run tests.

#### Functional Requirements
- The system shall invoke an external fingerprinting process to examine the working directory
- The system shall check whether the fingerprinting process is available before attempting to invoke it
- The fingerprinting process shall detect the project's technology stack by examining project manifest files, installed toolchains, CI configuration, directory structure, and file extensions
- The fingerprinting process shall determine the appropriate test command for the detected stack (e.g., by inspecting test scripts in manifests, detecting test runners, or identifying build systems)
- The fingerprinting process shall emit a project profile containing at minimum:
  - Detected stack/language identifier
  - Test command to execute (with arguments)
  - Any other stack-specific metadata useful to the orchestrator or agents
- The fingerprinting process shall also emit the codebase brief as a separate output — a human-readable summary of the project's structure, conventions, and key files
- The system shall load both the project profile and the brief from well-known output paths
- The system shall provide a mechanism to prepend the brief content to any agent prompt, wrapped in a structured tag
- The brief shall only be injected into an agent's first message in a session, or after a compaction event — not on every message

#### Inputs and Outputs
- **Input:** None (the fingerprinting process examines the working directory)
- **Output (brief):** A string containing the brief content, or an empty string if generation failed or was skipped
- **Output (profile):** A structured record containing at minimum the test command; empty/defaults if generation failed or was skipped

#### Interaction Model
- Consumed by: Test Gate (uses the test command from the profile), Slice Processing Pipeline / Gap Analysis Pass / Final Review Passes (inject the brief into agent prompts), Final Review Passes (uses stack identity to tailor audit scope)
- Called by: Orchestration Controller (once at startup)

#### Behavioural Rules
- Fingerprinting runs once at the start of orchestration, before any agents are spawned
- The brief is injected into a new agent session's first prompt
- After session compaction (between groups), the brief is re-injected since prior context is compressed
- If the brief is empty (generation failed or skipped), prompts proceed without it — no brief wrapper is added
- If the profile is empty or has no test command, the test gate shall report this clearly as a configuration error rather than silently skipping tests or crashing with a missing command

#### Modes and Configuration
- Brief generation can be skipped via a runtime flag
- The fingerprinting process path and output paths are configuration constants

#### Error Handling and Degradation
- If the fingerprinting process is not found at the expected path: log a warning and continue without a brief or profile
- If the fingerprinting process fails (non-zero exit): log the first portion of its output as a warning and continue without a brief or profile
- If the brief or profile files cannot be read after generation: return empty defaults

---

### Slice 6: Test Gate

#### Purpose
Acts as a quality gate between orchestration phases by running the project's test suite and reporting pass/fail. The test command is not hardcoded — it is provided by the project profile emitted during fingerprinting, making the orchestrator stack-agnostic.

#### Functional Requirements
- The system shall read the test command from the project profile produced by the fingerprinting feature
- The system shall execute that command synchronously and capture its exit code
- The system shall return a boolean indicating whether all tests passed
- The system shall capture and display test output on failure
- The system shall suppress verbose output on success
- The system shall include the detected test command in its log output so the operator can see what is being run

#### Inputs and Outputs
- **Input:** Project profile (containing the test command)
- **Output:** Boolean pass/fail result

#### Interaction Model
- Depends on: Codebase Fingerprinting (for the test command)
- Called by: Slice Processing Pipeline (after implementation, after each review-fix cycle), Gap Analysis Pass (after gap fixes), Final Review Passes (after fix cycles)

#### Behavioural Rules
- Tests run synchronously — the orchestrator blocks until completion
- A non-zero exit code from the test runner means failure
- Test output (stdout + stderr) is shown only on failure

#### Modes and Configuration
- The test command comes from the project profile, not from orchestrator configuration
- If the project profile provides no test command, the test gate shall fail with a clear error message rather than silently passing or crashing

#### Error Handling and Degradation
- Test failure is not fatal to the orchestrator — the caller decides whether to continue or abort the current phase
- If the test runner itself is not available (command not found), this manifests as a test failure with the command-not-found error visible in the output

---

## Group: Agent Execution Core

### Slice 7: Agent Execution Engine

#### Purpose
Manages the lifecycle of spawning a sub-agent process, streaming its output with real-time formatting, capturing the full assistant text during streaming for downstream use, and returning structured results. This is the core execution primitive — all agent interactions flow through this engine.

#### Functional Requirements
- The system shall spawn an external agent process with configurable flags and a prompt
- The system shall support two session modes:
  - **New session:** Creates a session with a generated unique identifier
  - **Resumed session:** Attaches to an existing session by identifier
- The system shall stream the agent's output in real time, parsing a structured JSON event stream
- The system shall format agent output with:
  - A coloured gutter prefix indicating which agent role is speaking
  - Word wrapping at the terminal width with continuation indentation
  - Syntax highlighting for specific keywords (e.g., TDD phase markers, commit references)
  - Collapsing of excessive blank lines
- **The system shall accumulate the full assistant text from all text blocks during streaming**, not just the last block, so that the complete agent output is available after the call returns without requiring a second round-trip
- The system shall return a structured result containing: exit code, the full accumulated assistant text, the result summary text, whether a question was detected, and the session identifier
- The system shall support a quiet mode that resumes a session with a prompt and captures the response as structured data without streaming (for cases where a second call is genuinely needed, such as requesting a summary in a specific format)

#### Inputs and Outputs
- **Input:** Prompt text (string), base flags (list of strings), session identifier (optional string — absent for new sessions), visual style configuration (label, colour, badge)
- **Output:** Structured result containing:
  - Exit code (integer)
  - Full assistant text (string — the complete text output captured during streaming)
  - Result summary text (string — from the result event)
  - Needs-input flag (boolean)
  - Session identifier (string)
- **Input (quiet mode):** Prompt text, base flags, session identifier (required — always resumes)
- **Output (quiet mode):** Result text (string)

#### Interaction Model
- Called by: Slice Processing Pipeline (TDD and review agents), Gap Analysis Pass, Final Review Passes, Interactive Follow-Up (for relay messages), Review Findings Extraction
- Depends on: Question Detection (to set the needs-input flag)
- The engine passes stdin through to the child process

#### Behavioural Rules
- Session identifiers are generated as UUIDs when not provided
- The first invocation for a session uses a "create" flag; subsequent invocations use a "resume" flag
- The streaming parser processes one JSON event per line, ignoring malformed lines
- Two event types are handled: "assistant" (contains message content to display) and "result" (contains final output and timing)
- After the result event, a summary line showing turn count and duration is displayed
- Word wrapping respects terminal width (default 120 columns) minus gutter width
- The quiet mode parser extracts the result field from a JSON envelope
- **Full assistant text accumulation:** Each text block from assistant events is appended to a running buffer. This buffer is returned alongside the result, making the review-to-TDD handoff possible without a "repeat yourself" call.

#### Modes and Configuration
- Base flags are passed through from the caller (typically include permission-skipping flags)
- Verbose mode and stream-JSON output format are always enabled for the streaming variant
- JSON output format is always used for the quiet variant
- Visual styling (colours, badges) is parameterised per agent role

#### Error Handling and Degradation
- If the agent process exits with a non-zero code, the exit code is captured in the result — the caller decides how to handle it
- Malformed JSON lines in the output stream are silently ignored
- If the process produces no result event, the exit code defaults to the process exit code (or 1 if null)

---

### Slice 8: Review Findings Extraction

#### Purpose
Retrieves the substantive content of a completed agent session for handoff to another agent. This exists because the orchestrator needs to pass review findings from the review agent to the implementation agent — the review agent's full output must be captured and transferable.

#### Functional Requirements
- When the agent execution engine captures full assistant text during streaming (see PRD 7), the extraction shall use that captured text directly — no second agent call required
- The system shall provide the extracted text in a form suitable for embedding in another agent's prompt
- For cases where a specific output format is needed that differs from the raw agent output (e.g., requesting a structured summary), the system shall use the quiet execution mode to ask the agent to produce the formatted output in a resumed session call

#### Inputs and Outputs
- **Input:** An agent execution result (containing full assistant text), or a session identifier (for quiet-mode extraction)
- **Output:** A string containing the agent's findings/output, ready for embedding in another prompt

#### Interaction Model
- Depends on: Agent Execution Engine (both the captured text from streaming and the quiet mode for formatted extraction)
- Called by: Slice Processing Pipeline (to extract review findings for the TDD agent), Gap Analysis Pass (to extract gap findings), Final Review Passes (to extract audit findings)

#### Behavioural Rules
- **Primary path:** Use the full assistant text captured during streaming. This avoids a second round-trip, eliminates the risk of the agent paraphrasing or truncating, and removes the latency and token cost of the "repeat yourself" pattern.
- **Secondary path (formatted extraction):** When the caller needs the agent to produce output in a specific structure (e.g., the slice summary), a quiet-mode resumed call is appropriate. This is for reformatting, not for retrieving what was already said.
- The extraction shall not modify or filter the agent's output — it is passed through verbatim

#### Modes and Configuration
- None

#### Error Handling and Degradation
- If the captured assistant text is empty (agent produced no text output), the extraction returns an empty string — the caller treats this as "no findings"
- If the quiet-mode extraction call fails, the extraction returns an empty string

---

### Slice 9: Interactive Follow-Up

#### Purpose
Bridges the gap between autonomous agent execution and human oversight. When an agent asks a question, this feature pauses the pipeline, presents the question to the operator, and relays their response back into the same agent session.

#### Functional Requirements
- The system shall check whether an agent result indicates a pending question
- If a question is detected and interaction is enabled, the system shall prompt the operator for a text response
- If the operator provides a response, the system shall relay it into the same agent session and collect the new result
- If the operator provides an empty response (presses Enter), the system shall send a default message instructing the agent to proceed autonomously with its best judgement
- The system shall repeat this prompt-relay cycle if the agent asks another question, up to a configurable maximum number of follow-ups
- The system shall return the final agent result after all follow-ups are resolved or the limit is reached

#### Inputs and Outputs
- **Input:** Agent result (with needs-input flag), session identifier, base flags, visual style, maximum follow-up count (default 3)
- **Output:** Final agent result after follow-ups are resolved

#### Interaction Model
- Called by: Slice Processing Pipeline (after TDD agent runs)
- Depends on: Agent Execution Engine (to relay messages back into the session)

#### Behavioural Rules
- The follow-up loop runs only while: the result has needs-input set to true, interaction is not globally disabled, and the follow-up count is under the maximum
- Empty operator responses trigger an autonomy message rather than being sent verbatim
- Each relay creates a new agent result that may itself contain a question, continuing the loop

#### Modes and Configuration
- Maximum follow-up count is configurable (default: 3)
- Global interaction flag can disable all follow-ups (the function returns immediately with the original result)

#### Error Handling and Degradation
- If the maximum follow-up count is reached and the agent is still asking questions, the system proceeds with the last result — the agent's question goes unanswered
- If the agent process fails during a follow-up relay, the failure result is returned to the caller

---

## Group: Slice Pipeline

### Slice 10: Slice Processing Pipeline

#### Purpose
Implements the core development loop for a single group: for each slice, drives an implementation agent through test-driven development, validates with tests, then enters a bounded review-fix cycle. This is where the actual code gets written, tested, and refined.

#### Functional Requirements
- The system shall iterate through each slice in a group in order
- For each slice, the system shall skip it if it was already completed in a prior run (based on persisted state)
- For each non-skipped slice, the system shall:
  1. Display a visual introduction showing the slice number, title, and first content line
  2. Run the implementation agent: prompt is the TDD skill invocation followed by the plan slice content as contextual data. No procedural instructions — the skill defines the methodology (see Cross-Cutting Concern: Prompt Construction Discipline).
  3. Run the follow-up handler to resolve any questions the implementation agent asks
  4. Run the test gate — if tests fail, skip to the next slice
  5. Enter a review-fix cycle (up to a configured maximum number of iterations):
     a. Check whether changes exist since the last review baseline — skip review if no diff
     b. Run the review agent: prompt is the review skill invocation followed by the commit reference and plan slice content as contextual data. The review skill defines the review methodology.
     c. Extract the review findings using captured assistant text from the review agent's execution (not a second "repeat yourself" call)
     d. If no findings, exit the review cycle (clean)
     e. Send review findings to the implementation agent: prompt is the TDD skill invocation followed by the plan slice content and the review findings as contextual data. The findings are scoping data (what to address); the skill defines how to address them (red-green-refactor). No "fix all issues" or "run tests after each change" — that's the skill's responsibility.
     f. **Classify the implementation agent's response** (see Behavioural Rules below)
     g. If the agent made changes: advance the review baseline to the current commit
     h. Run the test gate — log warning on failure but continue the review cycle
  6. Extract a structured summary from the implementation agent (this is a legitimate quiet-mode call requesting a specific format)
  7. Display the summary in a formatted box
  8. Mark the slice as completed in persistent state

#### Inputs and Outputs
- **Input:** A group (with its ordered list of slices), orchestrator state, codebase brief, project profile, whether to compact sessions before starting
- **Output:** Side effects — code changes committed to the repository, state updated
- **Internal data flow:** Slice content -> implementation agent -> code changes -> test gate -> review agent -> review findings (captured text) -> implementation agent -> code changes (cycle)

#### Interaction Model
- Depends on: Plan Parsing (slice structure), Orchestrator State Persistence (skip logic, session IDs), Codebase Brief Generation (brief injection), Version Control Change Detection (diff scoping), Test Gate (quality gates), Agent Execution Engine (running agents), Interactive Follow-Up (handling questions), Review Findings Extraction (getting review text for handoff)
- Called by: Orchestration Controller

#### Behavioural Rules
- Slices are processed strictly in order within a group
- The review-fix cycle is bounded by a configurable maximum (default: 3 cycles)
- The implementation agent's session persists across slices — it accumulates context
- The review agent's session also persists across slices within a run
- Session compaction (injecting a compact command before the prompt) occurs on the first slice of a group when the caller requests it, then is disabled for subsequent slices
- The brief is only injected on the first message of a new session or after compaction

**Agent outcome classification after receiving review feedback:**

The system shall distinguish three outcomes when the implementation agent is given review feedback to address:

1. **Deliberate rejection (no changes, exit code 0):** The agent ran successfully but chose not to make changes — it evaluated the review points and determined they are already addressed or not applicable. The orchestrator shall log this as an intentional decision and end the review cycle cleanly.

2. **Execution failure (non-zero exit code, or agent produced error output):** The agent process crashed, ran out of context, hit a tool error, or otherwise failed to execute properly. The orchestrator shall log this as a failure with the exit code and any available error output, and shall NOT treat it as "nothing to fix." The orchestrator shall either retry the fix (up to a bounded limit) or escalate to the operator depending on interaction mode.

3. **Successful fix (changes detected, exit code 0):** The agent made changes. Proceed to the next review cycle iteration.

The current "no changes detected" check is insufficient on its own — exit code must also be examined to distinguish case 1 from case 2.

Additionally, the review agent's exit code shall also be checked before extracting findings. If the review agent failed (non-zero exit), the system shall log the failure and skip that review cycle rather than extracting garbage from a failed session.

#### Modes and Configuration
- Maximum review cycles: configurable constant (default: 3)
- Session compaction: controlled by caller (compacted between groups)
- Agent base flags: configurable constants

#### Error Handling and Degradation
- Implementation agent failure on initial TDD: slice is skipped, processing continues with next slice
- Test gate failure after implementation: slice is skipped
- Test gate failure after review fix: warning logged, review cycle continues (the next review may catch regressions)
- Review agent failure: review cycle ends for this iteration; logged as a failure, not silently swallowed
- Implementation agent failure during fix pass: logged with exit code; treated as execution failure, not as deliberate rejection
- Review extraction returning empty text: treated as "no issues found" — review cycle ends cleanly

---

## Group: Post-Processing Passes

### Slice 11: Gap Analysis Pass

#### Purpose
Provides a second layer of test coverage validation after all slices in a group have been processed. While the per-slice review focuses on code quality, the gap analysis specifically targets missing test coverage and untested edge cases across the combined output of the group.

#### Functional Requirements
- The system shall run only if changes were made during the group (compared to the group's baseline commit)
- The system shall aggregate the content of all slices in the group into a single document
- The system shall spawn a dedicated agent to analyse test coverage gaps, scoped to changes since the group baseline
- The gap agent shall be instructed to look for:
  - Untested edge cases and boundary conditions
  - Missing coverage for feature combinations across slices
  - Integration paths between slices with no tests
  - Off-by-one scenarios, empty inputs, null inputs
  - Behaviours described in the plan with no corresponding tests
- The gap agent shall NOT report on code style, naming, architecture, or adequately-tested areas
- The system shall extract the gap agent's findings using captured assistant text from execution (not a second call)
- If gaps are found, the system shall send findings to the implementation agent: prompt is the TDD skill invocation followed by the group content and gap findings as contextual data. The scope constraint ("add tests only, do not refactor existing code") is legitimate scoping data — it limits what to change, not how. The skill defines the implementation methodology.
- After gap tests are added, the system shall validate with the test gate
- After passing tests, the system shall run the gap additions through the standard review-fix cycle (bounded by the same maximum as slice reviews). Review and fix prompts follow the same prompt construction discipline as the slice pipeline.
- The same agent outcome classification (deliberate rejection vs execution failure vs successful fix) shall apply to gap fix passes

#### Inputs and Outputs
- **Input:** Group (with slices), group baseline commit reference, orchestrator state, codebase brief
- **Output:** Side effects — additional test code committed to the repository

#### Interaction Model
- Depends on: Version Control Change Detection (baseline comparison), Agent Execution Engine (gap agent, implementation agent), Test Gate, Orchestrator State Persistence (session tracking), Codebase Brief Generation, Review Findings Extraction
- Called by: Orchestration Controller (after slice processing for each group)

#### Behavioural Rules
- The gap agent always gets a fresh session (not resumed from prior groups)
- If the gap agent's output contains a specific sentinel value ("NO_GAPS_FOUND"), no further action is taken
- If the gap agent's output is empty, it is treated as no gaps found
- The implementation agent is explicitly instructed to add tests only, not modify existing code
- The review-fix cycle after gap tests follows the same pattern as slice review-fix cycles
- The gap agent's exit code shall be checked — a failed gap agent is logged and skipped, not treated as "no gaps"

#### Modes and Configuration
- Maximum review cycles: same configurable constant as slice processing

#### Error Handling and Degradation
- Gap agent failure (non-zero exit): logged, gap analysis is skipped for this group
- Test gate failure after gap fixes: logged as a warning, review cycle is skipped
- Implementation agent failure during gap fixes: logged with exit code, treated as execution failure (not deliberate rejection)
- Implementation agent making no changes with exit code 0: logged as deliberate decision, gap fix cycle ends
- Gap extraction returning empty: treated as no gaps found

---

### Slice 12: Final Review Passes

#### Purpose
Provides a suite of targeted, cross-cutting audits that run after all groups are complete. These passes look at the entire run's changes holistically, catching issues that per-slice or per-group reviews might miss. The audit scopes are stack-aware — they adapt their focus based on the project profile detected during fingerprinting.

#### Functional Requirements
- The system shall run only if changes were made during the entire orchestration run
- The system shall execute three sequential audit passes, each performed by a fresh agent:

  1. **Type fidelity audit:** Searches all changes since the run baseline for type safety violations relevant to the detected stack. For a statically typed language, this includes: untyped value carriers, unchecked casts, convenience non-null assertions, untyped collection types where keys/shapes are known, incorrect nullability, and overly inferred types that should be explicit. The specific constructs to flag depend on the detected language (e.g., the audit for a C# project differs from a TypeScript project). For each finding, reports the file, line, issue description, and recommended fix.

  2. **Plan completeness audit:** Compares the full plan document against all changes since the run baseline. For each plan item, verifies: was it implemented, were specified edge cases handled, is there a test for each specified behaviour. Reports missing implementations, untested features, and implementations that diverge from the plan. This pass is stack-agnostic.

  3. **Cross-component integration audit:** Reviews cross-component integration across all changes since the run baseline. Checks: output/input type compatibility between components, exhaustive handling of variant types in dispatching logic, error propagation paths (warnings emitted, not swallowed), consistency of shared interface signatures across files. The specific patterns to check are informed by the detected stack but the categories are universal.

- Each pass agent receives the detected stack identity from the project profile so it can tailor its analysis
- Each pass agent produces its findings or a sentinel value ("NO_ISSUES_FOUND") if clean
- If findings are produced, the system shall extract them using captured assistant text and run a fix cycle:
  1. Send findings to the implementation agent: prompt is the TDD skill invocation followed by the plan content and audit findings as contextual data. The skill defines the fix methodology; the findings are scoping data.
  2. If changes were made and tests pass, enter a review-fix cycle (bounded by the standard maximum)
  3. Each review-fix iteration: review agent (invoked via review skill) inspects the fixes, findings sent to implementation agent (invoked via TDD skill), test gate validates. All prompts follow the prompt construction discipline.
- After each pass's fix cycle, run the test gate
- The same agent outcome classification applies to final fix passes

#### Inputs and Outputs
- **Input:** Run baseline commit reference, full plan document content, project profile (stack identity), orchestrator state, codebase brief
- **Output:** Side effects — fixes committed to the repository

#### Interaction Model
- Depends on: Version Control Change Detection (run baseline), Agent Execution Engine (audit agents, fix agents), Test Gate, Orchestrator State Persistence, Codebase Fingerprinting (stack identity for tailoring audits), Review Findings Extraction
- Called by: Orchestration Controller (after all groups complete)

#### Behavioural Rules
- Passes run in fixed order: type fidelity -> plan completeness -> cross-component integration
- Each audit agent gets a fresh session
- Findings are extracted using captured assistant text from the streaming execution
- If a pass is clean (sentinel value or empty findings), it is logged as clean and the next pass begins immediately
- The fix cycle follows the same pattern as slice review-fix cycles, including the three-way outcome classification
- Test failure after a pass's fixes is logged as a warning; the system proceeds to the next pass

#### Modes and Configuration
- The three pass categories are fixed; their specific focus areas adapt based on the project profile
- Maximum review cycles per pass: same configurable constant as slice processing

#### Error Handling and Degradation
- Audit agent failure: that pass produces no findings, logged as failure, effectively skipped
- Test failure after fixes: warning logged, next pass proceeds
- Implementation agent failure during fixes: logged with exit code, treated as execution failure
- Implementation agent making no changes with exit code 0: logged as deliberate decision, fix cycle ends

---

## Group: Orchestration Controller

### Slice 13: Orchestration Controller

#### Purpose
The top-level coordinator that ties all features together. Parses user-provided arguments, initialises all subsystems, and drives the execution flow from plan parsing through group processing to final review.

#### Functional Requirements
- The system shall accept the following runtime arguments:
  - **Plan path:** Path to the plan document (defaults to "plan.md" in the working directory)
  - **Automatic mode:** Flag to suppress inter-group confirmation prompts
  - **Skip fingerprint:** Flag to skip codebase brief and profile generation
  - **No interaction:** Flag to suppress all interactive prompts (operator questions, inter-group prompts)
  - **Group filter:** Name of a group to start from (skips all preceding groups)
- The system shall parse the plan document and validate that groups were found
- The system shall generate the codebase brief and project profile (unless skipped) and load both
- The system shall load persisted state for potential resume
- The system shall display a startup banner showing:
  - Plan file path
  - Brief status (present or absent)
  - Detected stack and test command (from profile)
  - Execution mode (automatic, interactive, or filtered to a specific group)
  - Session status for each agent role (existing session ID prefix or "new")
  - A numbered list of remaining groups with their slice numbers, with the starting group highlighted
- The system shall resolve the starting group:
  - If a group filter is provided, find the matching group (case-insensitive) and start from it
  - If no filter, start from the first group
  - If the specified group is not found, report available groups and terminate
- The system shall capture the run baseline commit reference before processing begins
- The system shall iterate through remaining groups:
  - For the first group, no session compaction
  - For subsequent groups, signal that sessions should be compacted (log a compaction message)
  - After each group (except the last), handle the inter-group transition:
    - **Automatic mode:** Log the next group name and proceed
    - **Interactive mode:** Prompt the operator to confirm proceeding to the next group; if declined, log resume instructions and terminate
- After all groups are processed, the system shall run the final review passes (only if changes were made during the run)
- The system shall display a completion banner with the final repository status
- The system shall clean up the persisted state file on successful completion

#### Inputs and Outputs
- **Input:** Command-line arguments, plan document file, repository state
- **Output:** Side effects — code changes in the repository, console output showing progress, state file created/updated/deleted

#### Interaction Model
- Depends on: Plan Parsing, Orchestrator State Persistence, Codebase Fingerprinting and Brief Generation, Version Control Change Detection, Test Gate, Slice Processing Pipeline, Gap Analysis Pass, Final Review Passes
- This is the entry point — no other features call it

#### Behavioural Rules
- Groups are processed in plan document order, starting from the resolved start index
- Session compaction occurs between groups (not within a group)
- The no-interaction flag is a global setting that affects all features (Interactive Follow-Up, inter-group prompts)
- **Automatic mode and no-interaction mode are independent:** Automatic mode suppresses inter-group prompts only. No-interaction mode suppresses all interactive prompts including agent question follow-ups. They can be combined (automatic + no-interaction = fully unattended) or used separately (automatic alone still allows agent question follow-ups).
- State file cleanup only happens on successful completion of all groups and final passes
- The gap analysis pass runs at the end of each group (within the group runner), after all slices

#### Modes and Configuration
- **Interactive mode (default):** Prompts between groups, allows follow-up to agent questions
- **Automatic mode:** No inter-group prompts (proceeds automatically); agent question follow-ups still work unless no-interaction is also set
- **No-interaction mode:** Suppresses all interactive prompts including agent question follow-ups
- **Group filter:** Starts from a named group, skipping all prior groups
- **Skip fingerprint:** Bypasses codebase brief and profile generation (test gate will need a fallback or will fail with a clear error)

#### Error Handling and Degradation
- Plan file not found: error message and termination
- No groups in plan: error message and termination
- Group filter not matching any group: error message listing available groups and termination
- State file cleanup failure: silently ignored
- Individual group/slice failures: handled by downstream features (logged, processing continues)
- No project profile available (fingerprint skipped or failed): the system shall warn at startup; the test gate shall report a clear configuration error rather than crashing with an opaque command-not-found
