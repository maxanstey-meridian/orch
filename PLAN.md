# TDD Orchestrator — Plan (PRDs 14–22)

## What this project is

A CLI tool that automates TDD-driven code generation using Claude as the underlying agent. The operator provides a
structured plan (groups of slices), and the orchestrator drives implementation agents through red-green-refactor cycles,
review-fix loops, gap analysis, and final audit passes — all with persistent agent sessions, state-based resumption, and
codebase-aware prompting.

## What already exists

Features 1–13 are implemented and working. Key files:

- **`src/main.ts`** (664 lines) — Procedural entry point. Parses CLI args (`--plan`, `--auto`, `--skip-fingerprint`,
  `--no-interaction`, `--group`). Spawns persistent TDD + REVIEW agents with skill injection via
  `--append-system-prompt`. Group loop: per-slice TDD → test gate → review-fix cycle → gap analysis → inter-group
  kill/respawn → final passes. ANSI colored output with box-drawing, timestamps.
- **`src/agent.ts`** (222 lines) — `createAgent(opts)` returns `AgentProcess` with `send()`, `sendQuiet()`, `kill()`,
  `alive`. Persistent processes via `--input-format stream-json --output-format stream-json`. NDJSON protocol: sends
  `{type:"user", message:{role:"user",content}, session_id}`, reads `assistant` + `result` events. Accumulates full
  assistant text during streaming.
- **`src/state.ts`** (42 lines) — `OrchestratorState` with `lastCompletedSlice?`, `lastCompletedGroup?`,
  `lastSliceImplemented?`. Manual type validation in `loadState()`. Reads/writes `.orchestrator-state.json`.
- **`src/fingerprint.ts`** (415 lines) — Inlined fingerprint logic. `runFingerprint()` detects stack, test command,
  architecture patterns. Generates `.orch/brief.md`. Caches for 1 hour. `wrapBrief()` wraps in `<codebase-brief>` tags.
- **`src/plan-parser.ts`** (67 lines) — Regex-based parser: `## Group: <name>` + `### Slice <N>: <title>`. Returns
  `Group[]` with `Slice[]`.
- **`src/git.ts`** (26 lines) — `captureRef()`, `hasChanges()`, `getStatus()` via `execFile`.
- **`src/test-gate.ts`** (29 lines) — Runs test command from profile. Returns `{ passed, output }`.
- **`src/question-detector.ts`** (29 lines) — Checks last 500 chars for `?` or conversational patterns.
- **`src/review-check.ts`** (17 lines) — `isCleanReview()` regex: "no issues found", "LGTM", "NO_ISSUES_FOUND", etc.
- **`src/extract-findings.ts`** (6 lines) — Returns `result.assistantText` verbatim.
- **Skills**: `skills/tdd.md` and `skills/deep-review.md` loaded at startup, passed via `--append-system-prompt`.

Patterns: no external deps (only `@types/node`, `typescript`, `vitest`), ES modules, strict TS, Vitest tests colocated
in `src/`, defensive I/O (silent fallbacks), ANSI via inline escape codes.

## Design decisions

- **No new dependencies except Zod** — PRD 21 explicitly requires Zod for state validation. Everything else stays raw
  Node.js.
- **Modify main.ts, don't replace it** — new features wire into the existing procedural flow. No new abstraction layers.
- **New features get their own files** — each PRD becomes a module (e.g. `src/repo-check.ts`, `src/review-threshold.ts`)
  imported by `main.ts`.
- **Agent protocol unchanged** — `createAgent()` API is stable. New features (credit detection, interrupts) layer on top
  of existing `AgentResult` and `AgentProcess`.
- **`--plan` flag changes meaning** — becomes "generate plan from inventory". New `--resume` flag takes over "continue
  existing plan" (PRD 15).
- **HUD uses ANSI scroll regions** — reserve bottom row, all log output scrolls above it. Degrade gracefully to no-HUD
  on dumb terminals.

---

## Group: Foundation

### Slice 1: Repository prerequisite check

**Why:** The orchestrator depends on git for change detection, commit refs, and diff-based review. Without a repo,
`captureRef()` and `hasChanges()` blow up mid-run with confusing errors. This fails fast at startup.

**File:** `src/repo-check.ts`

```typescript
const assertGitRepo: (cwd: string) => Promise<void>
```

Run `git rev-parse --is-inside-work-tree` via `execFile`. If it fails (non-zero exit or no `.git`), throw an error with
the message:

```
Not a git repository. The orchestrator requires git for change tracking.
Run: git init && git commit --allow-empty -m "init"
```

Then run `git rev-parse HEAD`. If it fails (no commits), throw:

```
Git repository has no commits. At least one commit is required.
Run: git commit --allow-empty -m "init"
```

Wire into `main.ts`: call `assertGitRepo(process.cwd())` as the very first thing in `main()`, before state loading or
fingerprinting. On throw, print the error message and `process.exit(1)`.

**Tests:** Call in a temp dir with no git → throws with "Not a git repository". Call in a `git init` dir with no
commits → throws with "no commits". Call in a dir with at least one commit → resolves. Verify the error messages contain
the suggested fix commands.

### Slice 2: State schema validation with Zod

**Why:** The current `loadState()` does manual type checks (e.g. `Number.isFinite()`, string length checks). Zod
replaces this with a declarative schema that's the single source of truth for the state shape, catches corrupt files
properly, and gives clear error messages.

**Files:** `src/state.ts` (modify), `package.json` (add `zod`)

Install Zod: add `"zod": "^3"` to dependencies in `package.json`.

Define the schema in `state.ts`:

```typescript
import {z} from 'zod';

const stateSchema = z.object({
  lastCompletedSlice: z.number().int().optional(),
  lastCompletedGroup: z.string().min(1).optional(),
  lastSliceImplemented: z.number().int().optional(),
}).passthrough(); // forward compatibility: ignore unknown fields

type OrchestratorState = z.infer<typeof stateSchema>;
```

Replace the manual validation in `loadState()`:

```typescript
const loadState = async (filePath: string): Promise<OrchestratorState> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return {};
  } // missing file → fresh start

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  } // corrupt JSON → fresh start

  const result = stateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Corrupt state file (${filePath}):\n${issues}\nDelete the file to start fresh, or use --reset.`);
  }
  return result.data;
};
```

Key change from current behaviour: corrupt-but-parseable JSON (e.g. `{"lastCompletedSlice": "banana"}`) now throws with
a diagnostic instead of silently returning `{}`. Missing file or unparseable JSON still returns `{}`.

Remove the old manual validation code (the `typeof` / `Number.isFinite` / `.length > 0` checks).

Add a `--reset` flag to `main.ts` arg parsing. When present, call `clearState(CONFIG.stateFile)` before loading state.
Print "State cleared." and continue.

**Tests:** Update existing `state.test.ts`. Valid state parses correctly. Missing file returns `{}`. Unparseable JSON
returns `{}`. Wrong types (string where number expected) throws with field name in message. Extra unknown fields are
preserved (passthrough). Negative/NaN numbers rejected by `.int()`. Empty string for `lastCompletedGroup` rejected by
`.min(1)`. Verify error message includes file path and "Delete the file" suggestion.

### Slice 3: Credit exhaustion detection

**Why:** When Claude hits its usage cap, the agent returns empty/truncated output with a non-standard exit code. The
orchestrator currently treats this as "agent finished with no changes" and silently skips the slice. This detects credit
exhaustion as a distinct failure mode and pauses orchestration.

**File:** `src/credit-detection.ts`

```typescript
type CreditSignal = {
  kind: 'mid-response' | 'rejected';
  message: string;
};

const detectCreditExhaustion: (result: AgentResult, stderr: string) => CreditSignal | null
```

Check `result.resultText` and `stderr` for known patterns (case-insensitive):

- `rate limit` → `{ kind: 'rejected', message: 'Rate limited. Wait and retry.' }`
- `credit` + (`exhaust` | `limit` | `exceed`) → `{ kind: 'rejected', message: 'Credits exhausted.' }`
- `quota` + (`exceed` | `limit`) → `{ kind: 'rejected', message: 'Quota exceeded.' }`
- `usage limit` → `{ kind: 'rejected', message: 'Usage limit reached.' }`

Distinguish `mid-response` vs `rejected`:

- If `result.assistantText.length > 0` and exit code non-zero + pattern matched → `kind: 'mid-response'` (agent started
  but got cut off)
- If `result.assistantText.length === 0` and pattern matched → `kind: 'rejected'` (never started)

Wire into `main.ts`: after every `agent.send()` call, check `detectCreditExhaustion(result, '')`. If signal detected:

1. Log: `"Credit exhaustion detected: ${signal.message}"`
2. Save state (so resume works)
3. If `signal.kind === 'mid-response'`, log:
   `"Agent was interrupted mid-response. The current slice will be re-run on resume."`
4. `process.exit(2)` — distinct from normal exit (0) and error exit (1)

To capture stderr: modify `createAgent()` in `agent.ts` to buffer stderr. Currently stderr is `"inherit"`. Change to
`"pipe"` and collect it. Add a `stderr` getter to `AgentProcess`:

```typescript
// In createAgent:
let stderrBuf = '';
child.stderr?.on('data', (chunk: Buffer) => {
  stderrBuf += chunk.toString();
});

// Add to AgentProcess:
get
stderr()
{
  return stderrBuf;
}
```

Then in `main.ts`, pass `agent.stderr` to `detectCreditExhaustion()`.

Credit exhaustion does NOT count as a review cycle or retry — it's a separate exit path.

**Tests:** Pattern matching: each known string triggers the right signal kind. Empty assistant text + pattern →
`'rejected'`. Non-empty assistant text + pattern → `'mid-response'`. No pattern match → `null`. Case-insensitive
matching. Multiple patterns in one string picks the first match.

---

## Group: Quality Gates

### Slice 4: Review minimum-change threshold

**Why:** When a slice produces only a few lines of code, running a full review cycle wastes credits and time. This gates
review entry on cumulative diff size, deferring review until changes accumulate past a threshold.

**File:** `src/review-threshold.ts`

```typescript
type DiffStats = { linesAdded: number; linesRemoved: number; total: number };

const measureDiff: (cwd: string, since: string) => Promise<DiffStats>
const shouldReview: (stats: DiffStats, threshold?: number) => boolean
```

`measureDiff()`: run `git diff --stat <since>..HEAD` via `execFile`. Parse the summary line (e.g.
`3 files changed, 45 insertions(+), 12 deletions(-)`). Extract insertions + deletions. If the command fails, return
`{ linesAdded: 0, linesRemoved: 0, total: 0 }`.

Also include uncommitted changes: run `git diff --stat` (no ref) for working tree. Add both totals.

`shouldReview()`: return `stats.total >= (threshold ?? 30)`.

Wire into `main.ts` in the review-fix loop. Currently the review runs if `hasChanges(cwd, reviewBase)` is true. Add
threshold check:

```typescript
// Before entering review-fix cycle:
const stats = await measureDiff(process.cwd(), reviewBase);
if (!shouldReview(stats)) {
  log(`  Diff too small (${stats.total} lines) — deferring review`);
  // Do NOT advance reviewBase — let changes accumulate
  continue; // skip to next slice
}
```

When review is deferred, don't advance `reviewBase` so the next slice sees the cumulative diff.

The threshold does NOT apply to:

- Review cycles 2+ within a slice (once started, finish)
- Final review passes (PRD 12) — always run
- Gap analysis — always runs if changes exist

Add `--review-threshold <n>` flag to main.ts arg parsing. Default 30. Value of 0 means "always review" (the current
behaviour).

**Tests:** `measureDiff()` in a real git repo: commit a file with 10 lines → stats show ~10 added. No changes →
`{ 0, 0, 0 }`. `shouldReview()` with total=29, threshold=30 → false. total=30 → true. total=31 → true. Default threshold
is 30. Threshold of 0 always returns true. Git failure returns zeroes (safe fallback to "review").

---

## Group: Init Mode

### Slice 6: Project initialisation — interactive bootstrap

**Why:** When the orchestrator runs against a fresh/empty directory, fingerprinting finds nothing useful. Init mode
gathers context from the operator through a dialogue, producing a project profile that feeds into brief generation and
agent prompts. This makes the first implementation slice produce code that matches the operator's intended style.

**Files:** `src/init.ts`, modify `src/main.ts`, modify `src/fingerprint.ts`

```typescript
type InitProfile = {
  language: string;          // e.g. "TypeScript", "C#", "Python"
  framework?: string;        // e.g. "NestJS", "ASP.NET", "Express"
  style?: string;            // free-text: naming conventions, architecture preferences
  linting?: string;          // e.g. "oxlint + oxfmt", "eslint", "none"
  references?: string[];     // paths to external context files (CLAUDE.md, style guides)
  extraContext?: string;     // anything else the operator wants agents to know
};

const runInit: (cwd: string) => Promise<InitProfile | null>
const profileToMarkdown: (profile: InitProfile) => string
```

`runInit()` uses `readline.createInterface()` (same pattern as the existing `ask()` in main.ts — extract it to a shared
util or import it):

1. Print: `"Initialising project profile. Press Enter to skip any question."`
2. Ask: `"Language? (e.g. TypeScript, C#, Python)"` → `profile.language`. If empty, return `null` (abort init — PRD says
   no answers = fall back to fingerprint-only).
3. Ask: `"Framework? (e.g. NestJS, Express, ASP.NET — or blank for none)"`
4. Ask: `"Coding style preferences? (naming, architecture, patterns — free text)"`
5. Ask: `"Linting/formatting tools? (e.g. oxlint + oxfmt, eslint, none)"`
6. Ask: `"Paths to reference files? (comma-separated, e.g. ../CLAUDE.md, ./styleguide.md)"` → split on comma, trim,
   filter to paths that exist (warn + skip non-existent).
7. Ask: `"Any other context for agents? (free text)"`
8. Close readline interface.

`profileToMarkdown()`: convert the profile into a markdown brief section that can be prepended to `.orch/brief.md`:

```markdown
## Project Profile (from init)

- **Language:** TypeScript
- **Framework:** NestJS
- **Style:** camelCase, Clean Architecture, no inheritance
- **Linting:** oxlint + oxfmt
- **References:** ../CLAUDE.md
- **Notes:** This is a monorepo, the API is in packages/api/
```

Wire into `main.ts`:

- Add `--init` flag to arg parsing.
- Init is mutually exclusive with `--group` resume (throw if both provided).
- If `--init`, call `runInit(process.cwd())` before fingerprinting.
- If init returns a profile, write `profileToMarkdown(profile)` to `.orch/init-profile.md`.
- Modify `runFingerprint()` in `fingerprint.ts`: if `.orch/init-profile.md` exists, read it and prepend to the generated
  brief. The init profile takes priority (operator-stated > auto-detected).
- Auto-suggest init: if `--init` not provided and fingerprint finds no manifest files (no `package.json`, no `*.csproj`,
  no `*.sln`), print: `"Empty project detected. Run with --init for guided setup."` (suggestion only, don't force).

**Tests:** Mock readline to simulate operator answers. Full answers → returns complete profile. Empty first answer (
language) → returns null. Non-existent reference paths → filtered out with warning. `profileToMarkdown()` produces
expected format. Verify init profile merges with fingerprint brief (init content appears first).

### Slice 7: Plan generation mode

**Why:** Currently the operator hand-writes plan files. This invokes an agent to transform a feature inventory into a
structured plan, then orchestrates it. Changes `--plan` to mean "generate from this inventory" and adds `--resume` for
continuing an existing plan.

**Files:** `src/plan-generator.ts`, modify `src/main.ts`, modify `src/plan-parser.ts`

```typescript
const generatePlan: (
  inventoryPath: string,
  briefContent: string,
  agent: AgentProcess,
) => Promise<string>  // returns path to generated plan file
```

`generatePlan()`:

1. Read the inventory file content.
2. Build a prompt for the agent that includes:
    - The inventory content
    - The codebase brief (if available)
    - Instructions: "Transform this feature inventory into a group-and-slice plan. Use `## Group: <name>` headings and
      `### Slice <N>: <title>` headings. Number slices sequentially from 1. Each slice needs: **Why**, **File**,
      concrete implementation details, and **Tests**. Target 2-3 slices per group, max 4. Respect dependency ordering."
3. Send via `agent.send()`.
4. Extract the plan markdown from `result.assistantText`. The agent's response IS the plan content (trim any
   preamble/postamble outside the first `#` heading).
5. Write to `.orch/generated-plan.md`.
6. Validate by calling `parsePlan()` on it — if parsing fails (no groups), throw with message.
7. Return the path.

CLI flag changes in `main.ts`:

- `--plan <path>` now means: "this is a feature inventory, generate a plan from it". The generated plan is written to
  `.orch/generated-plan.md` and then orchestrated.
- `--resume [path]` means: "continue an existing plan". If path provided, use it. If no path, look for
  `.orch/generated-plan.md`, then `plan.md`, in that order.
- If `.orch/generated-plan.md` already exists when `--plan` is used, prompt the operator: "A generated plan already
  exists. Regenerate? (y/N)". If N, switch to resume mode.
- `--plan-only` flag: generate the plan and exit without orchestrating. Print: "Plan written to
  .orch/generated-plan.md — review and run with --resume".

Detect inventory vs plan format: check if the file contains `## Group:` headings. If yes, it's already a plan (treat as
resume). If no, it's an inventory (generate).

Spawn a dedicated agent for plan generation (not the TDD or REVIEW agent). Use the same `createAgent()` with no special
system prompt — the generation instructions are in the user message.

**Tests:** Feed a minimal inventory (2 PRDs) → verify output contains `## Group:` and `### Slice` headings. Verify
generated plan parses successfully via `parsePlan()`. Verify `--plan-only` doesn't enter orchestration loop. Verify
existing plan detection prompts for regeneration. Verify inventory-vs-plan detection (file with `## Group:` = plan, file
without = inventory).

---

## Group: Operator Interrupt

### Slice 8: Mid-execution operator interrupt and guidance

**Why:** Currently the operator can only interact when the agent asks a question (reactive). This adds proactive
interrupts — the operator can inject guidance while an agent is running, without waiting for the agent to ask.

**Files:** modify `src/agent.ts`, `src/interrupt.ts`, modify `src/main.ts`

```typescript
// src/interrupt.ts
type InterruptHandler = {
  enable: () => void;     // start listening for keypress
  disable: () => void;    // stop listening
  onInterrupt: (callback: (message: string) => void) => void;
};

const createInterruptHandler: (noInteraction: boolean) => InterruptHandler
```

`createInterruptHandler()`:

- If `noInteraction` is true, return a no-op handler (enable/disable do nothing, callback never fires).
- Listen for a specific keypress on `process.stdin`: **Ctrl+G** (0x07, BEL — doesn't conflict with Ctrl+C which kills
  the process).
- When Ctrl+G detected:
    1. Pause the current output display (print newline to separate).
    2. Print: `"Interrupt — type guidance for the agent (or Enter to cancel):"`
    3. Read a line from stdin via readline.
    4. If non-empty, fire the callback with the message.
    5. If empty, print `"Cancelled."` and resume.

Modify `AgentProcess` in `agent.ts` — add an `inject(message: string): void` method:

```typescript
// In createAgent, add to the returned AgentProcess:
inject(message
:
string
)
{
  if (!this.alive) return;
  const framed = `[ORCHESTRATOR GUIDANCE] The operator has provided the following guidance. ` +
    `You are still operating within an orchestrated TDD workflow — incorporate this guidance ` +
    `into your current task, do not switch to freeform mode.\n\n${message}`;
  const payload = JSON.stringify({
    type: 'user',
    message: {role: 'user', content: framed},
    session_id: this.sessionId,
  });
  child.stdin?.write(payload + '\n');
}
```

This injects a message into the agent's session mid-turn. The agent receives it as a new user message in its
conversation. The framing makes clear this is orchestrated guidance, not a mode switch.

Wire into `main.ts`:

- Create handler: `const interrupt = createInterruptHandler(noInteraction);`
- Before each `agent.send()`, call `interrupt.enable()` and set up the callback:
  ```typescript
  interrupt.onInterrupt((msg) => currentAgent.inject(msg));
  ```
- After `agent.send()` returns, call `interrupt.disable()`.

The interrupt fires asynchronously — the agent is actively processing when the message arrives. This is by design; the
agent processes it at its next natural boundary.

If the operator sends Ctrl+C during the interrupt prompt itself, the normal SIGINT handler runs (saves state, exits
cleanly).

**Tests:** `createInterruptHandler(true)` → no-op (enable/disable/onInterrupt are all safe to call, callback never
fires). Test the framing string contains "[ORCHESTRATOR GUIDANCE]" and the operator's message. Test `inject()` writes
valid NDJSON to stdin. Test `inject()` on dead process is a no-op. (Keypress detection is hard to unit test —
integration test manually.)

---

## Group: Status Line

### Slice 9: Persistent HUD status bar

**Why:** The operator currently has to read scrolling log output to figure out where orchestration is. The HUD renders a
fixed status bar at the bottom of the terminal showing slice progress, elapsed time, active agent, and usage info —
always visible, never scrolled away.

**File:** `src/hud.ts`, modify `src/main.ts`

```typescript
type HudState = {
  currentSlice?: { number: number; title: string };
  totalSlices: number;
  completedSlices: number;
  groupName?: string;
  groupSliceCount?: number;
  groupCompleted?: number;
  activeAgent?: string;          // "TDD", "REVIEW", "GAP", "FINAL"
  activeAgentActivity?: string;  // last log line from agent (truncated)
  startTime: number;             // Date.now() at orchestration start
  creditSignal?: string;         // from credit detection, or undefined
};

type Hud = {
  update: (partial: Partial<HudState>) => void;
  teardown: () => void;
  wrapLog: (logFn: (...args: unknown[]) => void) => (...args: unknown[]) => void;
};

const createHud: (enabled: boolean) => Hud
```

`createHud(false)` returns a no-op: `update` does nothing, `teardown` does nothing, `wrapLog` returns the original
function unchanged.

`createHud(true)`:

1. On init, check `process.stdout.isTTY`. If false, return no-op (piped output, CI).
2. Get terminal size: `process.stdout.columns`, `process.stdout.rows`.
3. Set up a scroll region that excludes the bottom row: `\x1b[1;${rows-1}r` (ANSI escape: set scroll region to rows 1
   through rows-1).
4. Move cursor to bottom row and render initial status bar.

`update()`:

- Merge partial into internal state.
- Build the status line string:
  ```
  S4/13 | Group: Foundation [===>    ] 2/3 | TDD: implementing... | 00:12:34 | Credits: ok
  ```
- Slice counter: `S${current}/${total}`
- Group progress: name + ASCII bar `[====>   ]` + `completed/count`
- Active agent + truncated activity (max 30 chars)
- Elapsed: `HH:MM:SS` from `startTime`
- Credits: `creditSignal ?? 'ok'`
- Truncate entire line to `process.stdout.columns` to avoid wrapping.
- Save cursor, move to bottom row, clear line, write status, restore cursor.

`teardown()`:

- Clear the scroll region: `\x1b[r` (reset to full terminal).
- Clear the bottom row.
- Move cursor to end of scrollable content.

`wrapLog()`:

- Returns a function that, before printing, saves cursor position, scrolls content area if needed, prints the log line,
  then re-renders the status bar on the bottom row.
- This ensures log output appears ABOVE the bar, not over it.

Handle `SIGWINCH` (terminal resize): recalculate `rows`/`columns`, reset scroll region, re-render.

Wire into `main.ts`:

- `const hud = createHud(!process.env.CI && process.stdout.isTTY !== false);`
- Add `--no-hud` flag to disable.
- Replace the `log()` function: `const log = hud.wrapLog(console.log);`
- Call `hud.update()` at key milestones: slice start, group start, agent switch, review cycle, slice complete.
- Call `hud.teardown()` in the cleanup/exit handler (alongside agent kill).
- Start a 1-second interval for elapsed time updates: `setInterval(() => hud.update({}), 1000);` (the update
  recalculates elapsed from startTime).
- If credit detection (Slice 3) fires, call `hud.update({ creditSignal: signal.message })` before exiting.

**Tests:** `createHud(false)` → `update()` and `teardown()` don't throw. `createHud(true)` with mocked stdout (
isTTY=true, columns=80, rows=24) → verify scroll region escape sequence is emitted. `update()` with slice/group state →
verify output string contains expected fields (slice counter, group name, elapsed format). `teardown()` emits scroll
region reset. `wrapLog()` returns a function that still prints the original content. Verify line truncation at terminal
width.
