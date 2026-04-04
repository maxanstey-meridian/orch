# PROPER Orchestration Plan

## Objective

Make Orch follow this model exactly:

1. Startup:
    - request triage decides execution mode: `direct | grouped | sliced`
2. Before each next execution unit:
    - a tier selector reads that unit's content and returns `trivial | small | medium | large`
3. After each completed unit:
    - a boundary triager reads the resulting diff and returns pass decisions

The important split is:

- mode selection is a startup concern
- tier selection is a pre-unit concern
- verify/completeness/review/gap selection is a post-unit concern

These are separate policies and must not be conflated.

---

## Target Runtime Model

### Startup

- `--plan <inventory>`:
    - request triage reads the request/inventory
    - returns `direct | grouped | sliced`
- `--work <plan>`:
    - execution mode comes from plan metadata
    - no request triage override in `auto`

### Before Each Execution Unit

- `direct`:
    - tier selector reads the whole direct request once
- `grouped`:
    - tier selector reads the current group's content before the group runs
- `sliced`:
    - tier selector reads the current slice content before that slice runs

The selected tier applies to:

- `plan`
- `tdd`
- `review`
- `gap`

It does not select:

- `verify`
- `completeness`

Those remain post-unit checks. `verify` uses one global verifier skill, and `completeness`
uses prompt-local logic rather than a tiered role prompt.

It does not hot-swap during an active unit. It changes at unit boundaries only.

### After Each Completed Execution Unit

Boundary triage reads:

- diff since base
- diff stats
- pending pass windows
- final-boundary metadata

Boundary triage returns only:

- `verify`
- `completeness`
- `review`
- `gap`
- `reason`

It must not decide tier.

---

## Mode Semantics

### Direct

- Startup request triage may choose `direct`
- Orch does not generate a plan
- Orch treats the request as one bounded whole
- Tier selector runs once on the whole direct request
- TDD executes the whole request
- Expensive passes run once at the end
- No per-slice cadence exists inside direct mode

### Grouped

- Orch executes one group as one bounded unit
- Tier selector runs before each group
- Boundary triage runs after each group
- Deferred passes may still flush at final group boundaries if needed

### Sliced

- Orch executes slices one by one
- Tier selector runs before each slice
- Boundary triage runs after each slice
- Deferred passes may accumulate and flush at group end

---

## Current Gap

The current codebase is only partly aligned with this design.

What is already true:

- startup request triage decides mode
- tier can change between execution units
- runtime boundary triage exists
- deferred pass windows exist
- completeness/verify/review order was corrected

What is still wrong:

- runtime boundary triage still owns `nextTier`
- tier changes are inferred from the completed diff instead of selected from the next/current unit content
- startup still seeds runtime policy from a one-shot complexity decision instead of the first unit
- the contracts still treat tier policy and boundary-pass policy as one combined concern

That means the system can mechanically switch tiers between units, but it is doing so from the wrong signal.

---

## Required Refactor

## 1. Split The Contracts

### Keep

- `RequestTriageResult`
- `ComplexityTriageResult`

### Replace

Current runtime `TriageResult` should be split.

Introduce a boundary-only result:

```ts
export type BoundaryTriageResult = {
  readonly completeness: PassDecision;
  readonly verify: PassDecision;
  readonly review: PassDecision;
  readonly gap: PassDecision;
  readonly reason: string;
};
```

`nextTier` should be removed from boundary triage.

### New Port

Add a dedicated pre-unit tier selector:

```ts
export type ExecutionUnitTierInput = {
  readonly mode: ExecutionMode;
  readonly unitKind: "slice" | "group" | "direct";
  readonly content: string;
};

export abstract class ExecutionUnitTierSelector {
  abstract select(input: ExecutionUnitTierInput): Promise<ComplexityTriageResult>;
}
```

This selector reads the unit content and answers only one question:

- how hard is this unit?

It must not decide boundary passes.

---

## 2. Simplify Boundary Triage

`ExecutionUnitTriager` should become boundary-only.

Its input should continue to describe:

- mode
- completed unit kind
- diff
- diff stats
- review threshold
- final boundary
- more units remain
- pending pass windows

It should not carry tier selection.

`diff-triage.ts` should:

- stop asking for `nextTier`
- stop parsing `nextTier`
- only parse pass decisions plus `reason`

Fallback should become:

- full boundary pipeline

not:

- full boundary pipeline plus current tier

---

## 3. Move Tier Selection To Unit Start

Add a helper in `RunOrchestration`:

```ts
private async prepareTierForUnit(unit: ExecutionUnit): Promise<void>
```

Responsibilities:

- call the new tier selector with `unit.content`
- compare returned tier with current `activeTier`
- persist `activeTier`
- respawn tier-sensitive agents if tier changed

This helper should run:

- before direct execution starts
- before grouped execution starts
- before each sliced `planThenExecute(...)`

Important:

- run this before planning
- plan prompts are also tier-sensitive
- on resume inside an already-started unit, do not re-select tier for that in-flight unit
- keep the persisted `activeTier` for that unit and re-select at the next unit boundary

Boundary policy should no longer call `applyNextTier(...)`.

---

## 4. Clean Up Startup

`main.ts` should keep startup request triage exactly where it is for inventory-mode bootstrapping.

But startup complexity triage should stop participating in runtime tier policy.

Preferred shape:

- request triage still selects `direct | grouped | sliced`
- startup seeds `activeTier` only from persisted state or a static default
- the first authoritative tier decision happens in `prepareTierForUnit(...)`
- per-unit tier selection stays authoritative after that

Reasonable fallback at startup:

```ts
existingState.activeTier ?? existingState.tier ?? "medium"
```

Startup should not invoke a one-shot complexity classifier to choose runtime tier.

Resume rule:

- if resuming mid-unit, keep the persisted `activeTier` for that in-flight unit
- only run `prepareTierForUnit(...)` again when moving to the next unit

---

## 5. Reduce Config Coupling

`OrchestratorConfig` currently still carries startup-loaded tiered `skills`.

That is historical baggage now that runtime prompt resolution exists.

The clean model is:

- config carries skill enablement and overrides
- runtime prompt bodies come from `RolePromptResolver`

The immediate minimum fix is:

- keep `skills` only for enable/disable checks
- stop treating it as the authoritative source of tiered prompt bodies

The better follow-up is:

- split `skills` into:
    - enabled/disabled capability flags
    - runtime prompt resolution through `RolePromptResolver`

This lets `main` stop caring about initial tier just to build the container.

---

## 6. Reuse Existing Complexity Classifier Properly

The existing complexity classifier in `complexity-triage.ts` is already close to the right abstraction.

Reuse it as the backend for the new unit-tier selector:

- runtime:
    - before each execution unit

This avoids inventing a second separate prompt family for the same classification problem.
It should not be used as a one-shot startup classifier anymore.

---

## File-Level Plan

### Domain / Application Contracts

- `src/domain/triage.ts`
    - split boundary triage result from complexity result
    - remove `nextTier` from boundary triage
- `src/application/ports/execution-unit-triager.port.ts`
    - make boundary triage boundary-only
- `src/application/ports/execution-unit-tier-selector.port.ts`
    - add new pre-unit tier selector port

### Runtime Orchestrator

- `src/application/run-orchestration.ts`
    - add `prepareTierForUnit(...)`
    - call it before each execution unit
    - remove boundary-driven tier changes
    - keep boundary triage pass-only

### Infrastructure

- `src/infrastructure/complexity-triage.ts`
    - keep parser/prompt for unit hardness selection
- `src/infrastructure/execution-unit-tier-selector.ts`
    - add adapter using the existing triage model
- `src/infrastructure/diff-triage.ts`
    - remove `nextTier` from prompt/parser
- `src/infrastructure/execution-unit-triager.ts`
    - return boundary-only decisions
- `src/infrastructure/factories.ts`
    - add `executionUnitTierSelectorFactory`
- `src/composition-root.ts`
    - inject the new selector

### Startup / Config

- `src/main.ts`
    - keep request triage for mode selection
    - seed fallback tier from persisted state or `"medium"`
    - do not call one-shot startup complexity triage for runtime tier policy
- `src/domain/config.ts`
    - reduce the coupling between `skills` and prompt bodies
- `src/infrastructure/skill-loader.ts`
    - preserve runtime prompt lookup as the authoritative tiered prompt source

### Tests / Harness

- `tests/fakes/fake-execution-unit-triager.ts`
    - boundary-only fake
- `tests/fakes/fake-execution-unit-tier-selector.ts`
    - new fake selector
- `tests/fakes/harness.ts`
    - inject both selector and boundary triager
- lifecycle tests
    - assert tier selection is per-unit
    - assert boundary triage is post-unit only
    - assert tier changes respawn tier-sensitive agents before the next unit

---

## Safe Implementation Order

### Phase 1. Contract Split

- add `ExecutionUnitTierSelector`
- split boundary triage result from complexity result
- keep old runtime behavior compiling

### Phase 2. Infrastructure Split

- add runtime tier-selector adapter
- simplify boundary triage adapter and prompt/parser
- wire both through factories and DI

### Phase 3. Runtime Loop Changes

- add `prepareTierForUnit(...)`
- call it before each unit
- remove `applyNextTier(...)` from boundary policy

### Phase 4. Startup Simplification

- remove startup complexity triage from runtime tier policy
- clean up config/prompt loading assumptions

### Phase 5. Tests

- update fakes/harness
- add lifecycle tests for:
    - direct tier selection once
    - grouped tier selection per group
    - sliced tier selection per slice
    - boundary triage deciding passes only

---

## Acceptance Criteria

The implementation is only complete when all of these are true:

- startup request triage decides `direct | grouped | sliced`
- before each unit, a tier selector reads that unit's content and chooses tier
- after each completed unit, boundary triage reads the diff and chooses passes
- boundary triage no longer chooses tier
- startup no longer runs one-shot complexity triage to choose runtime tier
- `sliced` can run slice 1 with `trivial` prompts and slice 2 with `large` prompts because slice 2 itself was classified
  as `large`
- tier changes happen before planning/execution of the next unit
- direct mode still executes the whole request as one bounded unit with one tier decision
- resuming mid-unit preserves the persisted `activeTier` until that unit completes

---

## Principle

The correct rule is simple:

- read the request to choose mode
- read the unit to choose tier
- read the diff to choose post-unit checks

Anything more coupled than that is harder to reason about than it needs to be.
