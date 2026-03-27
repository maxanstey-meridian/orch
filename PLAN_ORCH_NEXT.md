# Orchestrator Cleanup — Collapse Indirection

## Context

The first refactor pass (plan-183541) successfully extracted an `Orchestrator` class from a 1500-line `main.ts`. The extractions are sound (`prompts.ts`, `display.ts`, `streamer.ts`) and the method decomposition is right (`run`, `runSlice`, `reviewFix`, `commitSweep`, `verify`, `gapAnalysis`, `finalPasses`). But the TDD bot over-engineered the wiring — injecting pure functions via constructor params, passing deps bags instead of using `this`, and creating indirection layers that serve no purpose.

This plan collapses that indirection. No new modules, no new abstractions. Just simplification.

## Group 1: Collapse Indirection

### Slice 1: Kill `GitPort`, import git functions directly

**What's wrong:** `GitPort` is a type wrapping three pure functions (`hasDirtyTree`, `captureRef`, `hasChanges`) that are injected via constructor. These are leaf I/O with no reason to stub — tests already use real git repos. The orchestrator should import them directly from `git.ts`.

**Changes:**
- Delete `GitPort` type from `orchestrator.ts`
- Remove `git` constructor param
- Replace all `this.git.captureRef(...)` → `captureRef(...)` (direct import from `./git.js`)
- Replace all `this.git.hasChanges(...)` → `hasChanges(...)`
- Replace all `this.git.hasDirtyTree(...)` → `hasDirtyTree(...)`
- Update `main.ts` constructor call to remove the `{ hasDirtyTree, captureRef, hasChanges }` arg
- Update test helpers (`makeOrch` / factory) to remove the `git` param. Tests that stub git behaviour should mock the module import, not inject a port.

### Slice 2: Kill `PlanThenExecuteDeps` — inline as method

**What's wrong:** `planThenExecute` is a standalone function in `main.ts` that takes a 15-field deps bag (`PlanThenExecuteDeps`). Every field except `sliceContent` is available on `this`. It's called from `run()` which is already a method on the class. This should be a method.

**Changes:**
- Move `planThenExecute` into `Orchestrator` as a method. Signature becomes `planThenExecute(sliceContent: string): Promise<PlanThenExecuteResult>`
- Move `buildPlanPrompt` into `prompts.ts` (it's a pure string builder, belongs there)
- Delete `PlanThenExecuteDeps` type
- Delete `RunDeps` type
- Remove `runDeps` constructor param and the four throw-on-missing fields (`planThenExecute`, `spawnPlanWithSkill`, `spawnGap`, `spawnFinal`)
- The method body uses `this.tddAgent`, `this.streamer(...)`, `this.withInterrupt(...)`, `this.sliceSkipFlag`, `this.hardInterruptPending`, `this.log`, `this.config`, `this.hud` directly
- `spawnPlanWithSkill` becomes a method or direct import (it's just `spawnPlanAgent(BOT_PLAN, planSkillContent)`)
- `spawnGap` / `spawnFinal` become methods: `private spawnGap() { return spawnAgent(BOT_GAP); }` — or just inline the call at the 2-3 sites that use them
- Update `run()` to call `this.planThenExecute(slice.content)` instead of `this.planThenExecute({ ...15 fields })`
- Delete `planThenExecute` and `buildPlanPrompt` from `main.ts`
- Move/update tests from `tests/plan-execute-flow.test.ts` — they should test the Orchestrator method, not a standalone function

### Slice 3: Kill injected `detectCredit`, `persistState`, `_isCleanReview`, `_measureDiff`

**What's wrong:** Four single-purpose functions are injected via constructor when they should be direct imports. None of them need to be swapped at runtime. Tests that need to control their behaviour can mock the module.

**Changes:**
- `detectCredit` → `import { detectCreditExhaustion } from "./credit-detection.js"` and call directly in `checkCredit`
- `persistState` → `import { saveState } from "./state.js"` and call directly
- `_isCleanReview` → `import { isCleanReview } from "./review-check.js"` and call directly in `reviewFix`
- `_measureDiff` → `import { measureDiff } from "./review-threshold.js"` and call directly in `runSlice`
- Remove all four constructor params
- Update `main.ts` constructor call
- Update test factory to drop these params. Tests that need to control these (e.g. force a credit exhaustion) should use `vi.mock()` or `vi.spyOn()` on the module import.

### Slice 4: Kill injected `spawnTdd`, `spawnReview`, `spawnVerify`

**What's wrong:** Agent spawn factories are injected as constructor params. The orchestrator already knows the skill content (it's in `config`). It should just call `createAgent` directly.

**Changes:**
- Import `createAgent` from `./agent.js` in `orchestrator.ts`
- Add `spawnAgent` private method that wraps the `createAgent` call with the standard CLI flags (currently duplicated in `main.ts`). Or import the factory from the new `agent-factory.ts` if the cleanup slice created one.
- `spawnTdd` method: `createAgent(BOT_TDD, this.config.tddSkill)` + `sendQuiet(TDD_RULES_REMINDER)`
- `spawnReview` method: same pattern with review skill + reminder
- `spawnVerify` method: same pattern with verify skill
- Move `TDD_RULES_REMINDER` and `REVIEW_RULES_REMINDER` into orchestrator (they're operational constants for the class)
- Remove `spawnTdd`, `spawnReview`, `spawnVerify` constructor params
- `respawnBoth` and `respawnTdd` call the new methods directly
- Update `main.ts`: spawn initial agents via the same factory, pass them to constructor. Or let the constructor spawn them itself (cleaner — constructor becomes async factory via static method if needed).
- Update tests

## Group 2: Trim Constructor

### Slice 5: Simplify constructor — static factory

**What's wrong:** After slices 1-4, the constructor should be much simpler. But `tddAgent` and `reviewAgent` still need async setup (sendQuiet). A static async factory is cleaner than forcing callers to pre-spawn.

**Changes:**
- Add `static async create(config, initialState, hud, log): Promise<Orchestrator>` that:
  - Spawns TDD + review agents
  - Awaits rules reminders
  - Returns `new Orchestrator(config, state, hud, log, tddAgent, reviewAgent)`
- Constructor becomes private, takes only: `config`, `initialState`, `hud`, `log`, `tddAgent`, `reviewAgent`
- `main.ts` calls `Orchestrator.create(...)` instead of manually spawning + constructing
- Everything else the class needs, it imports directly

### Slice 6: Clean up main.ts

**What's wrong:** After slices 1-5, `main.ts` should be pure CLI wiring: parse args, load skills, create HUD, call `Orchestrator.create()`, call `run()`. Anything remaining that isn't CLI arg parsing or startup sequencing should move.

**Changes:**
- Delete any remaining agent spawn helpers from `main.ts` (they're now methods/imports in orchestrator)
- Delete `planThenExecute`, `buildPlanPrompt` if not already gone
- Verify `main.ts` is ≤250 lines of pure CLI wiring
- Verify `orchestrator.ts` has zero deps bags and zero injected pure functions
- Run full test suite, confirm no regressions

## Verification

After all slices:
1. `grep -r "PlanThenExecuteDeps\|RunDeps\|GitPort" src/` — zero hits
2. `grep -r "deps\." src/orchestrator.ts` — zero hits
3. Constructor takes ≤6 params (config, state, hud, log, tddAgent, reviewAgent)
4. `npm test` — all tests pass
5. Manual run with `--work` on a small plan — full pipeline works
