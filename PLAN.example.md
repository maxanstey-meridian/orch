# Todo CLI — Plan

## What this project is

A command-line todo app that stores tasks in a local JSON file. You add, complete, list, and delete tasks from the
terminal. Tasks have a title, optional due date, priority (low/normal/high), and completion status. The list command
supports filtering by status and sorting by due date or priority.

Not a web app, not a database — just a CLI that reads and writes `~/.todos.json`.

## What already exists

Nothing. Fresh project.

## Design decisions

- **Single JSON file** — `~/.todos.json`, array of task objects. No SQLite, no config directory hierarchy. Read the
  whole file, mutate, write it back. Fine for hundreds of tasks; if someone has thousands they need a different tool.
- **No IDs in the UI** — tasks are referenced by line number from `list` output (1-indexed). Internally they have UUIDs
  for stable identity across sorts/filters.
- **Dates are ISO strings** — `2026-03-25`. No time component. "Overdue" means due date < today.
- **No categories/tags/projects** — keep it flat. Priority + due date is enough to sort by.

---

## Group: Core

### Slice 1: Task store — read/write JSON file

**Why:** Everything else depends on being able to persist and retrieve tasks. This is the data layer.

**File:** `src/store.ts`

Task shape:

```typescript
type Task = {
  id: string;          // UUID
  title: string;
  priority: 'low' | 'normal' | 'high';
  due?: string;        // ISO date string, e.g. "2026-03-25"
  done: boolean;
  createdAt: string;   // ISO datetime
};
```

Functions:

- `loadTasks(filePath): Promise<Task[]>` — reads and parses the JSON file. Returns `[]` if file doesn't exist. Throws on
  corrupt JSON (don't silently eat bad data).
- `saveTasks(filePath, tasks): Promise<void>` — writes the array as formatted JSON.
- `generateId(): string` — `crypto.randomUUID()`.

**Tests:** Write to a temp file, read it back. Verify empty file returns `[]`. Verify corrupt JSON throws. Verify
round-trip preserves all fields.

### Slice 2: Add and complete tasks

**Why:** The two most common operations. Adding creates a task; completing marks it done. Both mutate the task list and
persist.

**File:** `src/commands.ts`

Functions:

- `addTask(tasks, title, opts?): Task[]` — appends a new task with `done: false`, optional `priority` and `due`. Returns
  the new array. Does NOT write to disk — the caller does that (keeps I/O at the edges).
- `completeTask(tasks, index): Task[]` — marks the task at 1-indexed position as `done: true`. Throws if index is out of
  range. Returns the new array.

Why 1-indexed: the `list` command shows `1. Buy milk`, `2. Fix bug` — the user types `todo done 2`, not `todo done 1` (
off by one is the #1 source of bugs in CLI tools that use 0-indexed).

**Tests:** Add a task, verify it appears with correct defaults. Add with priority and due date. Complete task at valid
index. Complete at invalid index throws. Complete an already-done task is a no-op (idempotent, not an error).

### Slice 3: List and filter

**Why:** The read path. Users spend most of their time looking at the list — it needs to be useful by default and
filterable when the list gets long.

**File:** Add to `src/commands.ts`

Functions:

- `listTasks(tasks, opts?): Task[]` — returns a filtered/sorted copy.
    - `filter`: `'all' | 'pending' | 'done' | 'overdue'`. Default `'pending'`.
    - `sort`: `'priority' | 'due' | 'created'`. Default `'priority'`.
    - Priority sort order: high > normal > low. Within same priority, sort by due date (earliest first), then created
      date.
    - `'overdue'` filter: `done === false && due < today`. Tasks with no due date are never overdue.

**Tests:** List with mixed done/pending tasks — default shows only pending. Filter `'all'` shows everything. Filter
`'overdue'` with tasks due yesterday, today, tomorrow — only yesterday shows. Sort by priority puts high first. Sort by
due puts earliest first, tasks with no due date go last.

### Slice 4: Delete task

**Why:** Users need to remove tasks they added by mistake or no longer care about. Separate from "done" — done tasks are
still visible in `list --all`, deleted tasks are gone.

**File:** Add to `src/commands.ts`

- `deleteTask(tasks, index): Task[]` — removes the task at 1-indexed position. Throws if out of range. Returns the new
  array.

**Tests:** Delete at valid index removes it. Delete at invalid index throws. Delete from a single-item list returns
empty array.

## Group: CLI

### Slice 5: Wire it up — CLI entry point

**Why:** This is the part you actually run. Everything before this was pure functions with tests. This slice connects
them to `process.argv` and terminal output.

**File:** `src/main.ts`

Uses `process.argv` directly — no arg-parsing library. The command set is small enough:

```
todo add "Buy milk"
todo add "Fix bug" --priority high --due 2026-03-28
todo list
todo list --all
todo list --overdue
todo list --sort due
todo done 2
todo delete 3
```

Flow:

1. Parse the command (first positional arg after `todo`)
2. `loadTasks(STORE_PATH)`
3. Run the command function
4. `saveTasks(STORE_PATH, result)` if the list was mutated
5. Print output

List output format:

```
1. [!] Buy milk                          (due: Mar 28, overdue)
2.     Fix bug
3. [✓] Write tests                       (done)
```

- `[!]` = high priority, `[ ]` = normal (omitted), `[↓]` = low
- Due date shown if present, `overdue` appended in red if past
- Done tasks shown with `[✓]` and dimmed

**No tests for this file** — it's the wiring layer. The logic is tested in slices 1-4. Integration-test by running it.
