# CLAUDE.md

## What this is

TDD orchestrator. Takes a plan (groups of slices), runs agents through plan → execute → verify → review → gap analysis
per slice, with keyboard shortcuts for operator control.

## Architecture

Clean Architecture with ports and adapters. Dependency rule is strict:

- **Domain** (`src/domain/`) — pure functions, types, discriminated unions. No I/O, no imports from other layers.
- **Application** (`src/application/`) — `RunOrchestration` use case + port interfaces. Imports domain only.
- **Infrastructure** (`src/infrastructure/`) — port implementations (Claude/Codex spawners, git ops, filesystem
  persistence, prompt builders). Imports application ports + domain.
- **UI** (`src/ui/`) — Ink/React HUD, operator gates, progress sinks.

Ports are in `src/application/ports/`. They're abstract classes, implementations `implement` them (not `extends`). Each 
port is narrow — one concern.

Composition root is `src/composition-root.ts` using `typed-inject`. Factories in `src/infrastructure/factories.ts`
declare dependencies via `.inject`.

## Code conventions

- **Readonly everywhere.** State transitions create new objects via spread. No mutation.
- **Discriminated unions** for state machines (`Phase`, `StateEvent`, `GateDecision`, `VerifyDecision`). Exhaustive
  switch matching.
- **Pure functions in domain**, classes for stateful services in application/infrastructure.
- **`const` arrow functions**, not `function` declarations.
- **Early returns**, not nested ifs. Flat control flow.
- **No `any`, no `as` casts**, no `object` carriers. Model the actual type.
- **Config is Zod-validated** via `.orchrc.json`. No direct `process.env` reads outside CLI parsing.
- **Errors are concrete classes** (`CreditExhaustedError`, `IncompleteRunError`), caught by type in `main.ts`.
- **Subpath imports** use `#domain/`, `#application/`, `#infrastructure/`, `#ui/` aliases.

## Testing

Tests use a **lifecycle harness** that wires real production code with fakes at the I/O boundary:

```
REAL: RunOrchestration, InkProgressSink, InkOperatorGate
FAKE: FakeHud, FakeAgentSpawner, InMemoryGitOps, InMemoryStatePersistence
```

Harness is in `tests/fakes/harness.ts`. Use `createTestHarness()` for all orchestration tests.

### Rules

- **Test from the user's perspective.** Simulate keypresses with `hud.simulateKey("s")`, don't set
  `uc.sliceSkipFlag = true`.
- **Fakes over mocks.** Real objects with in-memory state (`tests/fakes/`), not `vi.fn()`. Mocks prove calls happened.
  Fakes prove things work.
- **Never assert broken behaviour.** No "documents the bug" tests. If it's broken, fix it or let the test fail red. A
  passing test that asserts the wrong outcome is invisible damage.
- **No ceremony tests.** "Does not throw", "is instance of", "delegates to X" — if removing the test wouldn't let a bug
  through, delete it.
- **Lifecycle over unit.** Run `execute()` with real groups/slices. Test the full chain, not individual methods in
  isolation.
- **If it's in the HUD, it must work.** Every displayed shortcut must have a working handler and a test. If it's not
  wired, remove it from the display.

### Running tests

```bash
npx vitest run                    # full suite
npx vitest run tests/lifecycle/   # lifecycle tests only
npx oxlint tests/                 # lint tests
```

## Agent skill prompts

Agent behaviour is defined in `skills/`. These are the source of truth — update them when conventions change.

- `skills/tdd.md` — TDD agent: RED→GREEN cycles, test philosophy, anti-patterns
- `skills/deep-review.md` — Review agent: structural audit, what to flag, what to ignore
- `skills/verify.md` — Verify agent: test/lint/typecheck validation
- `skills/plan.md` — Plan agent: slice planning
- `skills/gap.md` — Gap agent: test coverage gaps
- `skills/generate-plan.md` — Plan generation from inventory

## Key design decisions

- **State persistence is explicit.** `RunOrchestration` calls `persistence.save()` at specific checkpoints, not on every
  state change.
- **Retry logic is centralised** in `withRetry()` — don't add inline retry loops.
- **Group-level concerns aren't per-slice decisions.** Gap analysis always runs per group (not gated by triage). Triage
  gates per-slice checks (completeness, verify, review) only.
- **Triage classifies diffs** to skip expensive checks on trivial changes. Falls back to `FULL_TRIAGE` on failure. Lives
  in `src/infrastructure/diff-triage.ts`.
- **Keyboard shortcuts flow through** `FakeHud → InkProgressSink.onKey → callbacks → RunOrchestration`. The HUD is the
  single interaction point.
