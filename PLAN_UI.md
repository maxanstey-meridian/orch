# Plan Generation UI — Plan

## Problem

The `--plan` path (plan generation from inventory) is a black box:

- No HUD — it runs before the HUD mounts
- No streaming — the plan agent's output is invisible to the operator
- The "Regenerate? (y/N)" prompt uses a raw readline on stdout, bypassing ink
- No header/banner showing what's happening

## Current flow

```
main() →
  fingerprint →
  plan detection (readline prompt here) →
  plan generation (agent runs silently) →
  parsePlan →
  createHud (HUD mounts here) →
  slice loop
```

## Desired flow

```
main() →
  fingerprint →
  createHud (HUD mounts early, status: "Planning...") →
  plan detection (y/n prompt via HUD input bar) →
  plan generation (agent streams through HUD) →
  parsePlan →
  hud.update({ totalSlices }) →
  slice loop
```

## Changes

### 1. Mount HUD before plan generation

Move `createHud()` + `log = hud.wrapLog()` to BEFORE the plan detection logic. The HUD doesn't need `totalSlices` to
mount — it can show a "Planning..." status initially and update with slice counts once the plan is parsed.

Initial HUD state:
`{ totalSlices: 0, completedSlices: 0, startTime, activeAgent: "PLAN", activeAgentActivity: "generating..." }`.

### 2. Route "Regenerate?" through HUD

Replace the `ask("Regenerate? (y/N)")` readline call with a HUD prompt mode — similar to G/I interrupt but for
confirmations. Add a `startConfirm(prompt: string): Promise<boolean>` to the Hud type. When called, the HUD bar switches
to show the prompt with `(y/N)` and resolves the promise when the user presses Y or N.

Alternatively, simpler: just use the existing `startPrompt` mechanism. When the plan already exists, log "Plan already
exists" to the HUD, then `startPrompt("confirm")` which shows a y/n bar. No need for a full readline.

### 3. Stream plan agent output

`doGeneratePlan()` spawns a plan agent. Currently its output is silent. Wire `boundMakeStreamer(BOT_PLAN)` into the plan
agent's `send()` call so the operator sees the agent working. This requires `boundMakeStreamer` to exist before plan
generation — which it will if the HUD mounts earlier.

### 4. Remove early-log buffering

The `earlyLog` buffer was a workaround for log calls happening before the HUD. Once the HUD mounts first, the buffer is
unnecessary. All `log()` calls go through `wrapLog` from the start.

The only pre-HUD output is the `--plan-only` early exit path, which doesn't need the HUD at all (it exits immediately).

## Files

- `src/main.ts` — reorder HUD mount, wire plan agent streaming, remove earlyLog buffer
- `src/hud.tsx` — add `startConfirm` prompt mode (y/n bar), or reuse existing prompt with a "confirm" mode
- `src/plan-generator.ts` — accept optional `onText` callback or `Streamer` for streaming output

## Edge cases

- `--plan-only`: exits before slice loop. HUD should still teardown cleanly on exit.
- `--resume` (no plan generation): HUD mounts, plan detection is skipped, proceeds to slice loop. No change needed.
- Non-interactive mode: confirmations auto-resolve (use existing plan), no prompt shown.
