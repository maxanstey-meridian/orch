# Demo: TODO CLI

A minimal demo project that showcases the orchestrator's full pipeline. Small enough to follow, real enough to be
convincing.

## V1: Add-only TODO CLI (we build this manually)

### Structure

```
demo/todo/
  src/todo.ts          # domain: add, list, load, save
  src/cli.ts           # entry point: arg parser, no deps
  tests/todo.test.ts   # tests for add + list
  tsconfig.json        # strict, ESM
  package.json         # vitest only
  .orch/
    brief.md           # one-liner project description
```

### Domain (`src/todo.ts`)

Plain functions, flat file storage (`todos.json` in cwd).

```typescript
type Todo = { id: number; text: string; done: boolean };

const load = (path: string): Todo[]           // read + JSON.parse, return [] if missing
const save = (path: string, todos: Todo[])    // JSON.stringify + write
const add = (todos: Todo[], text: string): Todo[]  // append, auto-increment id
const list = (todos: Todo[]): string          // format as numbered lines
```

No classes, no frameworks. Pure functions + a file boundary.

### CLI (`src/cli.ts`)

```
node src/cli.ts add "Buy milk"
node src/cli.ts list
```

Arg parsing is just `process.argv.slice(2)`. Print to stdout. Exit 1 on unknown command.

### Tests (`tests/todo.test.ts`)

- `add` appends a todo with auto-incremented id
- `add` to empty list starts at id 1
- `list` formats as numbered lines
- `list` on empty returns "No todos"
- `load` returns [] for missing file
- `save` then `load` round-trips

Use tmp dirs for file tests. Vitest, no other deps.

### Brief (`.orch/brief.md`)

```
TODO CLI — a minimal command-line todo list app. TypeScript, vitest, flat file storage (todos.json). Pure functions, no frameworks.
```

---

## The Plan: Add Delete (the orchestrator runs this)

### `DELETE_PLAN.md`

Written as an inventory/feature spec that `--plan` can consume, or pre-formatted as a plan the orchestrator can run
directly with `--work`.

#### Feature: Delete a todo by ID

Users should be able to delete a todo by its ID. If the ID doesn't exist, print an error and exit 1.

```
node src/cli.ts delete 3
```

#### Acceptance criteria

- `delete` removes the todo with the matching id
- Remaining todos keep their original ids (no re-indexing)
- Deleting a non-existent id prints "Todo {id} not found" to stderr and exits 1
- Deleting from an empty list prints "Todo {id} not found" to stderr and exits 1
- `list` after `delete` shows the gap (id 1, id 3 — no id 2)

---

## Demo Flow

```bash
cd demo/todo

# 1. Show it works — add-only
node src/cli.ts add "Buy milk"
node src/cli.ts add "Walk dog"
node src/cli.ts list
# → 1. Buy milk
#   2. Walk dog

# 2. Show there's no delete
node src/cli.ts delete 1
# → Unknown command: delete

# 3. Run the orchestrator
node ~/.claude/orch/js/main.js --work DELETE_PLAN.md

# 4. Watch it:
#    PLN  plans 2-3 TDD cycles
#    TDD  RED: test delete removes by id → fails
#         GREEN: implement delete → passes
#         RED: test delete non-existent id → fails
#         GREEN: add error handling → passes
#         RED: test CLI integration → fails
#         GREEN: wire delete into cli.ts → passes
#    VFY  runs vitest, confirms green
#    REV  reviews the diff, REVIEW_CLEAN
#    GAP  checks for missing coverage

# 5. Show it works — delete added
node src/cli.ts delete 1
node src/cli.ts list
# → 2. Walk dog
```

## Why this demo works

- **Small enough to finish in ~5 minutes** — 2-3 slices, one group
- **Real enough to show the pipeline** — plan, TDD, verify, review, gap analysis all fire
- **Easy to follow** — everyone knows what a TODO app does
- **Shows the value** — you type one command and get tested, reviewed code
- **Reproducible** — fresh clone, `npm install`, run the orchestrator
