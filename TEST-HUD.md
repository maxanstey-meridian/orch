# HUD Test — Plan

## What this project is
A test plan to verify the HUD status bar renders correctly during orchestration.

## What already exists
Everything. This is a visual test only.

## Design decisions
- Do not modify any existing files
- Create throwaway test files only

---

## Group: Visual Check

### Slice 1: Create a greeting module

**Why:** Simple file creation to verify the HUD renders while the TDD agent streams output.

**File:** `src/hud-test-greeting.ts`

#### Cycle 1.1 — greet returns a greeting string

RED:   `greet("world")` returns `"Hello, world!"`. Test in `src/hud-test-greeting.test.ts`.
GREEN: Export `const greet = (name: string): string => "Hello, " + name + "!";`

#### Cycle 1.2 — greet with empty string

RED:   `greet("")` returns `"Hello, stranger!"`. Empty name falls back to "stranger".
GREEN: Add the empty check.

### Slice 2: Create a farewell module

**Why:** Second slice to verify HUD updates slice counter and progress bar.

**File:** `src/hud-test-farewell.ts`

#### Cycle 2.1 — farewell returns a farewell string

RED:   `farewell("world")` returns `"Goodbye, world!"`. Test in `src/hud-test-farewell.test.ts`.
GREEN: Export `const farewell = (name: string): string => "Goodbye, " + name + "!";`

#### Cycle 2.2 — farewell with empty string

RED:   `farewell("")` returns `"Goodbye, friend!"`. Empty name falls back to "friend".
GREEN: Add the empty check.
