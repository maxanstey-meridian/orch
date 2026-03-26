## HUD is broken — needs proper rewrite

The current `hud.ts` doesn't work. The scroll region approach fails because `makeStreamer` writes directly
to `process.stdout.write()`, bypassing `wrapLog`. The bar renders inline with content instead of staying
pinned to the bottom.

Attempted fix: monkey-patching `stdout.write` to intercept all writes. Result: bar duplicates on every
write, output garbled.

### The real problem

There are two independent output paths that both write to stdout:
1. `makeStreamer()` — raw `process.stdout.write()` calls for streaming agent output (13 call sites)
2. `log()` / `console.log` — structured log lines (timestamps, status, section headers)

The HUD needs to coordinate both. Options:

1. **Route all output through a single writer** — refactor `makeStreamer` to accept a write function
   instead of using `process.stdout.write` directly. The HUD provides the writer. This is the clean fix
   but touches every streaming call site.

2. **Use a real TUI library** (terminal-kit, ink) that owns stdout and provides a scrollable region API.
   Means giving up raw `process.stdout.write` everywhere — all output goes through the lib.

3. **Drop the fixed bar** — instead, print a status line between agent turns (after each `send()` returns).
   No scroll region needed, no stdout interception. Simpler, less fancy, actually works.

Option 3 is the pragmatic choice. Option 1 is the proper one. Option 2 is overkill for one status bar.
