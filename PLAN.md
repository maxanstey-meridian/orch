# TDD Orchestrator — Plan

## What this project is

A CLI tool that automates TDD-driven code generation using Claude as the underlying agent. The operator provides a
structured plan (groups of slices), and the orchestrator drives implementation agents through red-green-refactor cycles,
review-fix loops, gap analysis, and final audit passes — all with persistent agent sessions, state-based resumption, and
codebase-aware prompting.

## What already exists

All foundation features are implemented and tested (222 tests passing). Key files:

- **`src/main.ts`** (~1024 lines) — Procedural entry point. CLI flags: `--plan`, `--resume`, `--plan-only`, `--auto`,
  `--init`, `--group`, `--reset`, `--skip-fingerprint`, `--no-interaction`, `--review-threshold`. Spawns persistent
  TDD + REVIEW agents with skill injection via `--append-system-prompt`. Group loop: per-slice TDD → test gate →
  review-fix cycle → gap analysis → inter-group kill/respawn → final passes. ANSI streaming output with `makeStreamer()`.
- **`src/agent.ts`** (235 lines) — `createAgent(opts)` returns `AgentProcess` with `send(prompt, onText?)`,
  `sendQuiet()`, `kill()`, `alive`, `stderr`. Persistent processes via stream-json NDJSON protocol.
- **`src/state.ts`** — Zod-validated `OrchestratorState`. `loadState()`, `saveState()`, `clearState()`.
- **`src/fingerprint.ts`** (~513 lines) — `runFingerprint()` detects stack, test command, architecture. Generates
  `.orch/brief.md`. 1-hour cache. Reads `.orch/init-profile.md` if present. Suggests `--init` for empty projects.
- **`src/init.ts`** (95 lines) — `runInit()` interactive bootstrap, `profileToMarkdown()`. Wired via `--init` flag.
- **`src/plan-generator.ts`** (69 lines) — `generatePlan()` transforms feature inventory → plan via agent.
- **`src/plan-parser.ts`** (70 lines) — `parsePlan()`, `parsePlanText()`. Regex: `## Group:` + `### Slice <N>:`.
- **`src/repo-check.ts`** — `assertGitRepo()` fails fast if no git or no commits.
- **`src/credit-detection.ts`** — `detectCreditExhaustion()` with `mid-response` / `rejected` discrimination.
- **`src/review-threshold.ts`** — `measureDiff()`, `shouldReview()`. Defers review for small diffs.
- **`src/git.ts`** — `captureRef()`, `hasChanges()`, `getStatus()`.
- **`src/test-gate.ts`** — `runTestGate()`.
- **`src/review-check.ts`** — `isCleanReview()`.
- **`src/question-detector.ts`** — `detectQuestion()`.
- **Skills**: `skills/tdd.md` (TDD directive — primary methodology), `skills/deep-review.md`.

Patterns: Zod as only non-dev dep, ES modules, strict TS, Vitest tests colocated in `src/`, ANSI via inline escapes,
`oxlint` + `oxfmt` as dev tooling.

## Design decisions

- **No new dependencies** — everything stays raw Node.js + Zod.
- **Modify main.ts, don't replace it** — new features wire into the existing procedural flow.
- **New features get their own files** — imported by `main.ts`.
- **Agent protocol unchanged** — `createAgent()` API is stable. New features layer on top.
- **TDD skill is the primary methodology** — system prompt defines HOW (RED→GREEN cycles), user messages define WHAT
  (plan slices). Plans must contain explicit `#### Cycle N.M` with `RED:` / `GREEN:` blocks.
- **HUD uses ANSI scroll regions** — reserve bottom row, degrade gracefully on dumb terminals.

---

## Group: Operator Interrupt

### Slice 1: Mid-execution operator interrupt and guidance

**Why:** Currently the operator can only interact when the agent asks a question (reactive). This adds proactive
interrupts — the operator can inject guidance while an agent is running, without waiting for the agent to ask.

**Files:** `src/interrupt.ts`, modify `src/agent.ts`, modify `src/main.ts`

```typescript
type InterruptHandler = {
  enable: () => void;
  disable: () => void;
  onInterrupt: (callback: (message: string) => void) => void;
};

const createInterruptHandler: (noInteraction: boolean) => InterruptHandler
```

`createInterruptHandler()`:

- If `noInteraction` is true, return a no-op handler.
- Listen for Ctrl+G (0x07) on `process.stdin` in raw mode.
- When detected: print prompt, read a line via readline. If non-empty, fire callback. If empty, print "Cancelled."

Add `inject(message: string): void` to `AgentProcess` in `agent.ts`:

```typescript
inject(message: string) {
  if (!this.alive) return;
  const framed = `[ORCHESTRATOR GUIDANCE] The operator has provided the following guidance. ` +
    `You are still operating within an orchestrated TDD workflow — incorporate this guidance ` +
    `into your current task, do not switch to freeform mode.\n\n${message}`;
  writeMessage(framed);  // reuse existing writeMessage helper
}
```

Wire in `main.ts`: `interrupt.enable()` before each `agent.send()`, set callback to `currentAgent.inject(msg)`,
`interrupt.disable()` after send returns.

#### Cycle 1.1 — No-op handler for non-interactive mode

RED:   `createInterruptHandler(true)` — calling `enable()`, `disable()`, `onInterrupt(cb)` does not throw.
       Callback never fires. No raw mode set on stdin.
GREEN: Return object with no-op methods when `noInteraction` is true.

#### Cycle 1.2 — Ctrl+G detection in raw mode

RED:   `createInterruptHandler(false)` — call `enable()`, simulate 0x07 byte on stdin → callback fires
       with the message typed after the prompt. Simulate empty input → callback does not fire,
       "Cancelled." printed.
GREEN: `enable()` sets raw mode, listens for 0x07, reads line via readline, fires callback.

#### Cycle 1.3 — Agent inject method

RED:   `agent.inject("focus on tests")` → writes valid NDJSON to agent stdin containing
       "[ORCHESTRATOR GUIDANCE]" and the message. `agent.inject()` on dead process → no-op, no throw.
GREEN: Add `inject()` to `createAgent()` return, reuse `writeMessage()`.

#### Cycle 1.4 — Raw mode cleanup

RED:   After `disable()`, stdin is no longer in raw mode. After skip or interrupt, process can still
       exit cleanly (stdin unref'd). Multiple `enable()`/`disable()` cycles don't leak listeners.
GREEN: `disable()` restores stdin mode, removes listener, calls `unref()`.

---

## Group: Status Line

### Slice 2: Persistent HUD status bar

**Why:** The operator currently reads scrolling log output to figure out where orchestration is. The HUD renders a
fixed status bar at the bottom of the terminal — always visible, never scrolled away.

**File:** `src/hud.ts`, modify `src/main.ts`

```typescript
type HudState = {
  currentSlice?: { number: number; title: string };
  totalSlices: number;
  completedSlices: number;
  groupName?: string;
  groupSliceCount?: number;
  groupCompleted?: number;
  activeAgent?: string;
  activeAgentActivity?: string;
  startTime: number;
  creditSignal?: string;
};

type Hud = {
  update: (partial: Partial<HudState>) => void;
  teardown: () => void;
  wrapLog: (logFn: (...args: unknown[]) => void) => (...args: unknown[]) => void;
};

const createHud: (enabled: boolean) => Hud
```

Layout: `S4/13 | Group: Foundation [===>    ] 2/3 | TDD: implementing... | 00:12:34 | Credits: ok`

ANSI technique: `\x1b[1;${rows-1}r` sets scroll region excluding bottom row. `wrapLog()` wraps `console.log`
to print above the bar. Handle `SIGWINCH` for terminal resize.

#### Cycle 2.1 — No-op HUD

RED:   `createHud(false)` — `update()`, `teardown()` don't throw. `wrapLog(console.log)` returns a
       function that still prints the original content unchanged.
GREEN: Return no-op object when disabled.

#### Cycle 2.2 — Scroll region setup and teardown

RED:   `createHud(true)` with mocked stdout (isTTY=true, columns=80, rows=24) → init writes
       `\x1b[1;23r` (scroll region). `teardown()` writes `\x1b[r` (reset).
GREEN: Set scroll region on init, reset on teardown.

#### Cycle 2.3 — Status bar rendering

RED:   `update({ currentSlice: { number: 4, title: "X" }, totalSlices: 13, completedSlices: 3,
       groupName: "Foundation", groupSliceCount: 3, groupCompleted: 1, activeAgent: "TDD",
       startTime: Date.now() - 60000 })` → output contains "S4/13", "Foundation", "TDD", "00:01:00".
       Line is truncated to `columns` width.
GREEN: Build status string from state, save/restore cursor, write to bottom row.

#### Cycle 2.4 — wrapLog integration

RED:   `const log = hud.wrapLog(console.log)`. Call `log("hello")` → "hello" appears in stdout AND
       status bar is re-rendered on bottom row (not overwritten by log output).
GREEN: Wrapped function prints to scroll region, then re-renders status bar.

---

## Group: Operator QoL

### Slice 3: Skip-slice keypress

**Why:** When an agent is spinning its wheels, the operator has no escape hatch short of Ctrl+C which kills the
entire orchestrator. This adds a keypress that marks the current slice as done and advances.

**File:** `src/skip-handler.ts`, modify `src/main.ts`

```typescript
type SkipHandler = {
  readonly waitForSkip: () => Promise<boolean>;
  readonly cancel: () => void;
};

const createSkipHandler: (enabled: boolean) => SkipHandler
```

`createSkipHandler(false)`: `waitForSkip` never resolves, `cancel` is a no-op.

`createSkipHandler(true)`: raw mode on stdin, listen for Ctrl+S (0x13). `cancel()` resolves with false.

Wire in `main.ts` — race `tddAgent.send()` against `skip.waitForSkip()`. On skip: kill + respawn TDD agent,
advance state, continue to next slice. Print "Press Ctrl+S to skip current slice" at startup.

#### Cycle 3.1 — No-op handler

RED:   `createSkipHandler(false)` — `cancel()` doesn't throw. Promise from `waitForSkip()` never resolves
       (race with a resolved promise always picks the other).
GREEN: Return no-op when disabled.

#### Cycle 3.2 — Skip detection

RED:   `createSkipHandler(true)` — simulate 0x13 byte → `waitForSkip()` resolves with `true`.
       Call `cancel()` before any keypress → resolves with `false`.
GREEN: Raw mode listener for 0x13, cancel resolves the same promise with false.

#### Cycle 3.3 — Raw mode cleanup

RED:   After `cancel()` or skip, stdin is not in raw mode. Multiple create/cancel cycles don't leak.
GREEN: Both paths restore stdin and remove listener.

### Slice 4: Rebrief on every fresh CLI run

**Why:** The brief caches for 1 hour but the codebase changes significantly between runs. Stale briefs give
agents outdated context for the first slices of a new run.

**File:** modify `src/fingerprint.ts`, modify `src/main.ts`

Add `force?: boolean` to `FingerprintOptions`. When true, skip the mtime freshness check.
In `main.ts`, pass `force: true` on the initial startup call.

#### Cycle 4.1 — Force bypasses cache

RED:   Write a fresh brief (< 1 hour old). Call `runFingerprint({ force: true })` → brief is regenerated
       (mtime changes). Call `runFingerprint({ force: false })` with same fresh brief → returns cached.
GREEN: Guard the freshness check with `if (!opts.force)`.

#### Cycle 4.2 — Skip takes priority over force

RED:   `runFingerprint({ skip: true, force: true })` → returns defaults (empty brief, empty profile).
GREEN: `skip` check remains first in the function, short-circuits before `force` is evaluated.

#### Cycle 4.3 — Wiring in main.ts

RED:   Startup fingerprint call passes `force: !skipFingerprint`. When `--skip-fingerprint` is not set,
       brief always regenerates. Existing tests for `--skip-fingerprint` still pass.
GREEN: Change the `runFingerprint()` call in `main()` to include `force`.
