## Scoped plan context and multi-plan support

### Flag changes

- `--plan <inventory>` generates a plan only (no execution). Current `--plan-only` becomes redundant.
- `--work <plan>` executes a plan (what `--resume` does today). Rename `--resume` to `--work`.

### Plan file naming

Generated plans go to `.orch/plan-<short-uuid>.md`. Comment at the top references the source:

```markdown
<!-- Generated from: FEATURE_INVENTORY.md -->
```

The filename IS the key — no TOML header, no UUID parsing from inside the file.

### State keyed per plan

Instead of one flat `.orchestrator-state.json`, state lives at `.orch/state/plan-<uuid>.json`.
`--work` resolves which state file to use from the plan path.

```
.orch/
  plan-a1b2c3.md          ← generated from FEATURE_INVENTORY.md
  plan-d4e5f6.md          ← generated from CHANGES.md
  state/
    plan-a1b2c3.json      ← state for first plan
    plan-d4e5f6.json      ← state for second plan
  brief.md                ← shared (codebase-level, not plan-level)
```

### Multiple plans per repo

Each plan is an independent job. Different plans can run against the same repo without conflicting
state. The brief is shared since it describes the codebase, not the plan.
