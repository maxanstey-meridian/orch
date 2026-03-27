# CLEAN_PASS — Structural sanity pass + per-group final passes

## Goal

Three changes to the orchestrator:

1. Move final passes from whole-run to per-group
2. Add a fourth "structural sanity" final pass
3. Make the plan agent write aggressive cleanup slices

## Slice 1: Move final passes to per-group

### Files
- `src/orchestrator.ts`
- `src/prompts.ts`

### Changes

**`orchestrator.ts` — `run()`:**
- Remove the `await this.finalPasses(runBaseSha)` call after the group loop (line ~610)
- Inside the group loop, after `gapAnalysis` and `commitSweep` but before marking the group complete, add:
  ```
  const groupPlanContent = group.slices.map(s => s.content).join("\n\n---\n\n");
  await this.finalPasses(groupBaseSha, groupPlanContent);
  ```
- `runBaseSha` is no longer needed for final passes — can remove if nothing else uses it

**`orchestrator.ts` — `finalPasses()`:**
- Change signature from `finalPasses(runBaseSha: string)` to `finalPasses(baseSha: string, planContent: string)`
- Replace `this.config.planContent` with the `planContent` parameter in the `buildFinalPasses` call

**`prompts.ts` — `buildFinalPasses()`:**
- No signature change needed — it already takes `baseSha` and `planContent` as params
- The plan completeness pass now naturally scopes to group content since the caller passes group slices

### Why per-group is better
- Plan completeness checks only that group's slices against that group's diff — no false positives from earlier groups
- Type fidelity and cross-cutting catch issues while context is fresh, before the next group builds on top
- Structural sanity (slice 2) can flag problems before they get baked in by later groups
- Review agent is still alive for the group — fix cycles use the same context window

## Slice 2: Add structural sanity pass

### Files
- `src/prompts.ts`

### Changes

Add a fourth entry to the `buildFinalPasses` array:

```typescript
{
  name: "Structural sanity",
  prompt: `You are auditing architectural quality across all changes since commit ${baseSha}.

${buildReviewPreamble(baseSha)}

## What to look for
- Unnecessary indirection: wrapper types, intermediary interfaces with one implementation and no test double, classes that just forward to another class
- Deps bags: parameter objects or constructor injection where direct imports or \`this\` access would suffice
- Over-injection: DI for pure functions, leaf I/O, or things with exactly one implementation and no test seam
- Dead abstractions: interfaces/abstract classes with exactly one implementation that exists solely "for testability"
- Premature extraction: helpers/utilities called from exactly one site
- Mixed concerns: files that parse AND emit, validate AND transform, etc.
- Structural incoherence: code that doesn't follow the patterns established by the rest of the codebase

## What NOT to flag
- Style, formatting, naming (already reviewed)
- Test coverage gaps (separate pass)
- Abstractions that genuinely earn their place (multiple implementations, real test seams, clear boundary)
- Indirection required by the framework

If everything is structurally sound, respond with exactly: NO_ISSUES_FOUND`,
}
```

Place it as the last pass — run after type fidelity, plan completeness, and cross-cutting integration. Structural findings are lower severity than type lies or missing features.

## Slice 3: Aggressive cleanup slice guidance in plan skill

### Files
- `skills/plan.md`

### Changes

Add a new section after "## Rules":

```markdown
## Cleanup slices

If the slice is tagged as cleanup, refactoring, or structural improvement, your cycles must target
real structural problems — not just dead imports and file moves. Prioritise:

- **Unnecessary indirection** — wrapper types, intermediary interfaces with one implementation and
  no test double, classes that just delegate to another class. Inline them.
- **Deps bags** — parameter objects or constructor injection where direct imports or `this` access
  would be simpler. Replace with direct access.
- **Over-injection** — DI for pure functions, leaf I/O, or things with exactly one implementation
  and no test seam. Convert to direct imports.
- **Dead abstractions** — interfaces or abstract classes with exactly one implementation that
  exists solely "for testability" but has no test double. Remove the interface, use the concrete type.
- **Premature extraction** — helpers or utilities called from exactly one call site. Inline them.
- **Mixed concerns** — files or classes that do two unrelated things. Split them.

Each cleanup cycle is still RED→GREEN: write a test that exercises the simplified path, then
perform the simplification. If the cleanup is purely structural (same behaviour, less indirection),
the RED step can be "verify existing tests still pass after the change" rather than a new test.

Do NOT write timid cleanup cycles like "remove unused import" or "rename file". Those are
incidental — the plan author put them in a cleanup slice because there are structural problems
to fix.
```

## Execution order

Slices 1 and 2 touch different parts of the same files but slice 2 is just appending to the array that slice 1 re-wires, so do them sequentially: 1 then 2. Slice 3 is independent.
