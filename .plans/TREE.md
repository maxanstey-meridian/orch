# TREE: External Tree Support

## Direct Summary

Make Orch able to run against an already-existing checkout or worktree without trying to create or own it.

In human terms:

- "Use *that* tree I already have open."
- "Plan against the code in that tree, not repo root."
- "If that tree needs fixtures/symlinks/setup, make that explicit instead of failing mysteriously."

This plan intentionally narrows `WORKTREE.md` to the parts that look high-value right now.

---

## Problem

Current worktree support is biased toward Orch-managed trees:

- `--branch` can create a managed worktree
- persisted worktree state can be resumed
- but Orch cannot cleanly use an external tree path as the execution root

That creates three practical problems:

1. Follow-up passes on an existing tree are awkward
2. `--plan` can inspect the wrong code when the interesting branch state only exists in a tree
3. Fresh managed worktrees can miss repo-local setup such as ignored fixtures or symlinked assets

---

## Goal

Add explicit support for external trees so Orch can:

- execute with `--work ... --tree <path>`
- generate plans with `--plan ... --tree <path>`
- remember that tree in state for resume
- avoid deleting externally-managed trees on cleanup
- optionally run repo-defined post-create setup for Orch-managed worktrees

Non-goal:

- redesign the whole worktree model
- remove existing `--branch` behavior
- invent multi-tree orchestration

---

## CLI Behaviour

### New Flag

```bash
orch --work .plans/SOMETHING.md --tree .orch/trees/abc123
orch --plan inventory.md --tree ../some-existing-checkout
```

Meaning:

- use the provided directory as the agent working directory
- do not create a new worktree
- do not manage that tree's lifecycle

### Rules

- `--tree <path>` is mutually exclusive with `--branch <name>`
- the path must exist
- the path must be a git working tree
- cleanup must clear Orch state but must not remove an external tree

---

## Runtime Model

Two tree modes now exist:

1. Managed tree
   Orch created it via `--branch`

2. External tree
   User pointed Orch at it via `--tree`

Both should be resumable.
Only managed trees should be removable by Orch.

---

## State Model

Persist enough metadata to distinguish managed from external trees.

Preferred shape:

```ts
worktree: {
  path: string;
  branch: string;
  baseSha: string;
  managed: boolean;
}
```

Rules:

- `managed: true` for `--branch`-created worktrees
- `managed: false` for `--tree`-provided directories
- resume uses the persisted path
- cleanup only removes trees where `managed === true`

If branch detection for external trees is needed, capture it at setup time instead of inventing placeholder values.

---

## Implementation Slices

## Slice 1: CLI + Validation

### Why

Without a first-class `--tree` flag, the feature stays a workaround.

### Files

- `src/infrastructure/cli/cli-args.ts`
- `src/main.ts`
- relevant CLI tests

### Criteria

- `--tree <path>` is parsed as a path-valued flag
- `--tree` and `--branch` together fail with a clear error
- missing or non-existent `--tree` path fails early
- non-git `--tree` path fails early

### Tests

- parse `--tree`
- reject `--tree` with `--branch`
- reject invalid tree path
- reject path that is not a git worktree

---

## Slice 2: External Tree Resolution

### Why

This is the core feature: use an existing tree as cwd without creating a new worktree.

### Files

- `src/infrastructure/git/worktree-setup.ts`
- `src/infrastructure/git/worktree.ts`
- `src/domain/state.ts`
- state/worktree tests

### Criteria

- `resolveWorktree(...)` returns the external tree path as cwd when `--tree` is provided
- no `git worktree add` path is used for external trees
- external tree metadata is persisted with `managed: false`
- resume accepts persisted external tree state without requiring `--branch`
- cleanup clears state for external trees without deleting them

### Tests

- external tree path becomes effective cwd
- Orch does not try to create a managed worktree for `--tree`
- resume from external tree state reuses the path
- cleanup leaves the external tree on disk

---

## Slice 3: Planning From Tree Context

### Why

`--plan --tree ...` is not useful unless plan generation explores the tree you asked for.

### Files

- `src/main.ts`
- plan/bootstrap tests

### Criteria

- inventory-mode planning with `--tree` uses that tree as the effective cwd for planning agents
- generated plan bootstrapping still writes state and logs under the main repo's `.orch`
- request triage and plan generation both inspect the selected tree's code, not repo root

### Tests

- `--plan ... --tree ...` passes tree cwd into the relevant planning path
- generated plan execution still uses the repo-level Orch bookkeeping paths

---

## Slice 4: Managed Worktree Setup Hook

### Why

A created worktree is often not runnable until fixtures/symlinks/setup commands are applied.

### Files

- `src/infrastructure/config/orchrc.ts`
- `src/infrastructure/git/worktree-setup.ts`
- orchrc/worktree tests

### Behaviour

`.orchrc.json` may define:

```json
{
  "worktreeSetup": [
    "ln -s ../../openapi openapi"
  ]
}
```

Rules:

- only run for Orch-managed worktrees
- run after creation, before agents start
- run sequentially
- fail fast on non-zero exit
- do not run for `--tree`

### Criteria

- `worktreeSetup` is accepted as an optional string array in `.orchrc.json`
- setup commands run in the new managed tree cwd
- failed setup aborts execution before agents start
- setup commands are skipped for external trees

### Tests

- valid setup commands run in managed tree cwd
- failing setup aborts startup
- `--tree` does not trigger setup commands

---

## Trade-offs

Benefits:

- follow-up passes become normal instead of state hacks
- planning can inspect the actual branch state you care about
- tree environment setup becomes explicit and reproducible

Costs:

- tree state gets a little more complex
- cleanup/resume logic must distinguish managed vs external ownership
- invalid external-tree inputs now need stronger validation up front

---

## Recommended Order

1. Slice 1: CLI + validation
2. Slice 2: external tree resolution
3. Slice 3: planning from tree context
4. Slice 4: managed worktree setup hook

If you want the shortest path to value, stop after Slice 3.

---

## Manual Smoke Checks

### External Tree Execution

```bash
orch --work .plans/SOME_PLAN.md --tree /path/to/existing/tree
```

Check:

- Orch uses that tree as cwd
- no new worktree is created
- state records the tree path

### External Tree Resume

Run once, interrupt, then rerun:

```bash
orch --work .plans/SOME_PLAN.md --tree /path/to/existing/tree
```

Check:

- Orch resumes against the same tree
- no branch/create-worktree prompt appears

### External Tree Cleanup

```bash
orch --work .plans/SOME_PLAN.md --tree /path/to/existing/tree --cleanup
```

Check:

- Orch clears its state
- the external tree still exists on disk

### Planning From Tree

```bash
orch --plan inventory.md --tree /path/to/existing/tree
```

Check:

- generated plan reflects code that only exists in that tree
- not stale repo-root state

### Managed Worktree Setup Hook

Configure `.orchrc.json` with a harmless setup command, then run:

```bash
orch --work .plans/SOME_PLAN.md --branch test-tree
```

Check:

- setup command runs in the new managed tree
- startup aborts if the setup command fails
