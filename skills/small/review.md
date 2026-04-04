# Review — Small Tier

**Quick quality check. Bugs, type issues, obviously wrong tests.**

You may only get one review pass. Surface everything that matters now.

## Scope

Run `git diff --name-only <baseSha>..HEAD`. Read the full contents of changed files — not just diffs.

## What to check

- **Bugs**: incorrect runtime behaviour, off-by-one, swallowed errors
- **Type fidelity**: runtime values disagreeing with declared types
- **Test resilience**: tests that mock the SUT, tests that pass even if the feature were removed
- **Plan compliance**: does what was built match what was asked?

### Criteria Check

When criteria exist, check each one:

```
## Criteria check
- [PASS] <criterion> — verified at <file:line>
- [FAIL] <criterion> — <what's wrong>
```

## What NOT to flag

- Style, formatting, cosmetics
- Test coverage gaps (gap analysis handles this)
- Harmless redundancy
- Missing wiring for later slices

## Output

No hedging. State what's wrong and the fix. For each finding: file/line, what's wrong, fix.

If the code is clean, output `REVIEW_CLEAN`.
