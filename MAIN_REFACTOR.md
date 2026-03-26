# main.ts Teardown Plan

## Context

main.ts is 1522 lines / ~55KB — half the entire codebase. The `main()` function alone is ~870 lines. It owns 13+ mutable
`let` bindings, and every extracted function either threads those bindings through parameter lists (reviewFixLoop has *
*16 parameters**) or takes a deps bag (commitSweep). The autonomous agent that built this treated classes and shared
state as radioactive, so every function is "pure" in syntax but entangled in practice. The result is worse than what it
was trying to avoid.

The code is a procedural pipeline with genuine mutable shared state (agents get killed/respawned, flags toggle, progress
accumulates). That's fine — the problem is the refusal to give that state a home.

## Diagnosis: Why a class

The mutable state in `main()` breaks into three clusters:

1. **Agent lifecycle** — `tddAgent`, `reviewAgent`, `tddFirstMessage`, `reviewFirstMessage`. Agents get killed and
   respawned at group boundaries and on hard interrupt. The "first message" flags reset in sync with respawn — this
   coupling is an invariant with no enforcement.

2. **Interrupt/control** — `interruptTarget`, `sliceSkippable`, `sliceSkipFlag`, `hardInterruptPending`. Set by HUD
   keyboard callbacks, consumed by the async pipeline. Classic shared-mutable between event handlers and a loop.

3. **Progress** — `state` (persisted OrchestratorState), `globalSlicesCompleted`. Updated after each slice, saved on
   credit exhaustion.

Every phase function needs an arbitrary subset of these. Threading them as parameters created the 16-param mess. A deps
bag (commitSweep) works for one function but doesn't scale. Module-level state is untestable.

A class is the honest answer: the state is mutable, shared, and has invariants across fields (agent + firstMessage
flags). `this` eliminates parameter threading. Methods are independently testable by constructing with controlled deps.
This isn't an abstraction exercise — it's giving co-mutated state a name.

## File structure after refactor

### New files

**`src/prompts.ts`** (~240 lines)
All `build*` prompt functions — pure string templates, zero state:

- `buildTddPrompt` (currently line 283)
- `buildCommitSweepPrompt` (line 318)
- `buildReviewPreamble` (line 377)
- `buildReviewPrompt` (line 408)
- `buildGapPrompt` (line 432)
- `buildFinalPasses` (line 461)

**`src/display.ts`** (~80 lines)
ANSI constants (`a`), timestamp helper (`ts`), bot style definitions (`BOT_TDD`, `BOT_REVIEW`, `BOT_GAP`, `BOT_FINAL`,
`BOT_VERIFY`, `BOT_PLAN`), `logSection`, `printSliceIntro`, `printSliceSummary`.

**`src/streamer.ts`** (~110 lines)
`makeStreamer`, `Streamer` type, `WriteFn` re-export. The word-wrapping/gutter formatter that's currently inline in
main.ts (lines 139–246).

**`src/orchestrator.ts`** (~500–600 lines)
The class. See detailed design below.

### Modified files

**`src/main.ts`** (~150–200 lines)
Shrinks to: CLI arg parsing, fingerprint, plan resolution, construct `Orchestrator`, call `run()`. The procedural setup
script it should have always been. Reads top-to-bottom, no deep nesting.

**`tests/main.test.ts`**

- `buildCommitSweepPrompt` tests: update import to `src/prompts.ts` (trivial)
- `commitSweep` tests: migrate to construct `Orchestrator` with test deps, or keep as standalone with deps bag (see open
  question below)
- Integration tests (CLI spawn): unchanged — they test the binary, not internals
- Credit exhaustion / state tests: may need rework depending on how exitOnCreditExhaustion moves

## Orchestrator class design

```typescript
// src/orchestrator.ts

type OrchestratorConfig = {
  readonly cwd: string;
  readonly planPath: string;
  readonly planContent: string;
  readonly brief: string;
  readonly noInteraction: boolean;
  readonly auto: boolean;
  readonly reviewThreshold: number;
  readonly stateFile: string;
  readonly tddSkill: string;
  readonly reviewSkill: string;
  readonly verifySkill: string;
};

class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly hud: Hud;
  private log: (...args: unknown[]) => void;

  // Agent lifecycle — co-mutated, hence grouped
  private tddAgent: AgentProcess;
  private reviewAgent: AgentProcess;
  private tddIsFirst = true;
  private reviewIsFirst = true;

  // Interrupt/control — set by HUD, consumed by pipeline
  private interruptTarget: AgentProcess | null = null;
  private sliceSkippable = false;
  private sliceSkipFlag = false;
  private hardInterruptPending: string | null = null;

  // Progress
  private state: OrchestratorState;
  private slicesCompleted = 0;

  constructor(config, initialState, hud, log) { ... }

  // ── Public API ──
  async run(groups: Group[], startIdx: number): Promise<void>
  cleanup(): void

  // ── Pipeline phases (private) ──
  private async runSlice(slice, reviewBase): Promise<string>  // returns new reviewBase
  private async verify(slice, reviewBase): Promise<boolean>   // spawn verify agent, retry flow, ask operator
  private async reviewFix(content, baseSha): Promise<void>
  private async gapAnalysis(group, groupBaseSha): Promise<void>
  private async commitSweep(groupName): Promise<void>
  private async finalPasses(runBaseSha): Promise<void>

  // ── Agent lifecycle (private) ──
  private respawnTdd(): void        // kill + spawn + reset tddIsFirst
  private respawnBoth(): void       // kill both + spawn both + reset both flags
  private streamer(style): Streamer // bound to HUD writer, clears activity

  // ── Control flow helpers (private) ──
  private async withInterrupt<T>(agent, fn): Promise<T>
  private async exitOnCreditExhaustion(result, agent): Promise<void>
  private async followUp(result, agent): Promise<AgentResult>
  private isAlreadyImplemented(tddText: string, headSha: string, baseSha: string): boolean
  private setupKeyboardHandlers(): void
}
```

Key invariant enforcement that the current code lacks:

- `respawnTdd()` atomically kills, re-spawns, and resets `tddIsFirst` — impossible to forget the flag reset
- `respawnBoth()` does the same for inter-group transitions
- `setupKeyboardHandlers()` wires HUD callbacks to fields on `this` — no fragile closures over `let` bindings
- `verify()` encapsulates the spawn → check → retry → ask-operator flow that's currently inline
- `isAlreadyImplemented()` encapsulates the text-match + HEAD-comparison check

## What main.ts becomes

```
main():
  1. Parse CLI args                          (~40 lines)
  2. assertGitRepo, runInit, runFingerprint  (~30 lines)
  3. Resolve/generate plan                   (~50 lines)
  4. Load state, parse plan                  (~15 lines)
  5. Create HUD, create Orchestrator         (~10 lines)
  6. Print banner, call orchestrator.run()   (~20 lines)
  7. Cleanup                                 (~5 lines)
```

~170 lines. Still procedural, still reads top-to-bottom. The orchestrator construction is explicit — you can see every
dependency going in.

## What `run()` looks like inside the class

```
run(groups, startIdx):
  for each group:
    groupBaseSha = captureRef()
    for each slice:
      skip if already completed (this.state)
      reviewBase = await this.runSlice(slice, reviewBase)
    await this.gapAnalysis(group, groupBaseSha)
    await this.commitSweep(group.name)
    this.respawnBoth()            // inter-group reset
    prompt or auto-continue
  await this.finalPasses(runBaseSha)
```

~60 lines for the outer loop. Each phase method is 50–100 lines. The 16-param `reviewFixLoop` becomes
`this.reviewFix(content, baseSha)` — two params, because everything else is on `this`.

## Open question: commitSweep

`commitSweep` is currently the only well-tested extracted function (15 tests, deps bag). Do:

**Class method** — commitSweep becomes `private async commitSweep(groupName)`. Tests construct `Orchestrator` with
test deps. Cleaner long-term, but requires test migration.

## Migration order

Each step is independently shippable (tests pass after each):

1. **Extract `src/prompts.ts`** — move all `build*` functions. Update imports in main.ts and tests. Zero behaviour
   change.

2. **Extract `src/display.ts`** — move ANSI constants, bot styles, terminal helpers. Update imports. Zero behaviour
   change.

3. **Extract `src/streamer.ts`** — move makeStreamer. Update imports. Zero behaviour change.

4. **Create `src/orchestrator.ts`** — build the class, moving code from main.ts phase by phase. Start with the fields
   and constructor, then move `reviewFixLoop` first (biggest win — 16 params → 2), then `runSlice` (including verify
   gate and already-implemented detection), then remaining phases. main.ts shrinks incrementally.

5. **Migrate tests** — update imports for prompts, migrate commitSweep tests to class construction.

6. **Clean up main.ts** — should be ~150–200 lines at this point. Remove dead code.

## Verification

- `npm test` passes after each migration step
- `npx tsx src/main.ts --resume --no-interaction` runs a real plan (integration smoke test)
- No new exports beyond what's needed (prompts are exported for tests, class is exported for tests + main)
- Line counts: main.ts < 200, orchestrator.ts < 600, prompts.ts < 250

## Note on PLAN_UI.md

There's a separate planned change to mount HUD earlier and stream plan generation. That change becomes simpler after
this refactor: the early-log buffer hack (lines 714–825) lives in main.ts's setup phase and stays there — the
orchestrator doesn't need to know about it. If HUD mounts earlier, the buffer just disappears from main.ts without
touching the orchestrator at all.
