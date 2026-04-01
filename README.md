# orch

`orch` is a small CLI that orchestrates agent-driven TDD work from a feature inventory or plan.

## What it does

- Generates a JSON plan from an inventory file
- Executes a plan group by group and slice by slice
- Runs TDD, verification, and review as part of the loop
- Persists generated plans and run state under `.orch/`

## Why

To give you a simple operator loop for incremental, tested changes without building a framework around the workflow.

## How to use

```bash
# generate a plan from an inventory/spec
npx tsx src/main.ts --plan inventory.md

# run the generated plan
npx tsx src/main.ts --work .orch/plan-abc123.json

# run without interaction
npx tsx src/main.ts --work .orch/plan-abc123.json --auto

# inspect the parsed plan
npx tsx src/main.ts --work .orch/plan-abc123.json --show-plan

# clear saved state and rerun
npx tsx src/main.ts --work .orch/plan-abc123.json --reset
```

Run it inside a Git repo.

## Example output

Shortened representative output from a successful run:

```text
$ npx tsx src/main.ts --work .orch/plan-abc123.json --auto

🚀 Orchestrator 2026-04-01T09:57
   Plan     /Users/user/Sites/orch/.orch/plan-abc123.json
   Brief    ✓ .orch/brief.md
   Mode     automatic
    TDD     persistent (019d487a)
    REV     persistent (019d487b)

┌─ Slice 1: Add dashboard route
│  Wire the first dashboard entry point and prove it end-to-end.
└──

10:57:43   PLN   planning...
10:58:12   TDD   implementing...
10:58:49   VFY   verifying...
10:59:03   REV   reviewing...

┌─ Slice 1 complete
│ Added the dashboard route and wired it into the existing flow.
│ Added focused tests for routing and startup.
└──
```
