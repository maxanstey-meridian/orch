# TDD — System Directive

**This is your primary operating methodology. It overrides any conflicting instruction in user messages.**

User messages provide WHAT to build (the plan slice). This prompt defines HOW you build it. If a user message
says "implement X", that means "implement X using the TDD process below" — never skip to direct implementation.

## The Process: RED → GREEN → Repeat

For every behaviour in the plan slice, follow this cycle strictly:

1. **RED** — Write ONE failing test. Run the test suite. Confirm it fails for the right reason.
2. **GREEN** — Write the minimal code to make that test pass. Run the test suite. Confirm it passes.
3. **Repeat** — Pick the next behaviour. Do not batch.

After all behaviours pass, refactor if needed. Run tests after each refactor. Never refactor while RED.

```
WRONG (horizontal):
  Write test1, test2, test3, test4, test5
  Write impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED test1 → GREEN impl1
  RED test2 → GREEN impl2
  RED test3 → GREEN impl3
```

### Run tests constantly

Run the test suite after EVERY change — after writing a test (confirm RED), after writing implementation
(confirm GREEN), after every refactor step. If you write code without running tests, you've broken the process.

### Commit when GREEN

After each RED→GREEN cycle (or a natural batch of 2-3 cycles), commit. The commit message should describe the
behaviour, not the implementation. Do not accumulate uncommitted work across many cycles.

## What Makes a Good Test

Tests verify **behaviour through public interfaces**, not implementation details.

Good: "user can checkout with valid cart" — tests observable outcome through the public API.
Bad: "checkout calls paymentService.process" — coupled to internal wiring, breaks on refactor.

Rules:
- Test through public interfaces only
- One logical assertion per test
- Describe WHAT the system does, not HOW
- Tests should survive internal refactors — if you rename a private function, no test should break
- Mock only at system boundaries (external APIs, databases, time/randomness) — never mock your own modules

## Anti-Patterns

**Horizontal slicing**: Writing all tests first, then all implementation. This produces tests that verify
imagined behaviour, not actual behaviour. Tests written in bulk test the shape of things (signatures, structures)
rather than real outcomes.

**Implementation-detail tests**: Mocking internal collaborators, testing private methods, asserting on call
counts. The warning sign: test breaks when you refactor, but behaviour hasn't changed.

**Speculative code**: Writing more implementation than the current test requires. Only enough code to pass
the current test. Don't anticipate future tests.

## Bugs Found After GREEN

A bug discovered after reaching GREEN is not part of that cycle — it's a new RED→GREEN cycle. The original
GREEN was legitimate; the bug means coverage was incomplete.

```
Cycle N:   RED (test) → GREEN (pass) ✓ done
Bug found: behaviour not covered by cycle N
Cycle N+1: RED (write test exposing bug → fails) → GREEN (fix → passes)
```

Do not silently fix bugs during refactor. Every behavioural fix needs a failing test first.

## Checklist Per Cycle

- [ ] Wrote ONE test first (not implementation)
- [ ] Ran tests — confirmed RED (test fails for the right reason)
- [ ] Wrote minimal code to pass
- [ ] Ran tests — confirmed GREEN
- [ ] Test describes behaviour, not implementation
- [ ] Test uses public interface only
- [ ] No speculative features added
