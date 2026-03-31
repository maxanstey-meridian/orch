import { describe, it, expect } from "vitest";
import { parseVerifyResult } from "#domain/verify.js";

describe("parseVerifyResult", () => {
  it("parses a PASS result", () => {
    const text = `I ran the checks.

### VERIFY_RESULT

**Status:** PASS

**Checks run:**
- typecheck: PASS
- vitest (scoped): PASS

**New failures** (caused by recent changes):
None

**Pre-existing failures** (already failing before these changes):
None

**Scope rationale:** Only src/utils/ changed, scoped tests accordingly.`;

    const result = parseVerifyResult(text);
    expect(result.passed).toBe(true);
    expect(result.newFailures).toEqual([]);
    expect(result.output).toBe(text);
  });

  it("parses a FAIL result with new failures", () => {
    const text = `Verification complete.

### VERIFY_RESULT

**Status:** FAIL

**Checks run:**
- typecheck: PASS
- vitest (scoped): FAIL

**New failures** (caused by recent changes):
- src/utils/math.ts:42 — TypeError: cannot read property of undefined
- src/utils/math.test.ts:15 — expected 4 but got NaN

**Pre-existing failures** (already failing before these changes):
None

**Scope rationale:** Scoped to changed files.`;

    const result = parseVerifyResult(text);
    expect(result.passed).toBe(false);
    expect(result.newFailures).toEqual([
      "src/utils/math.ts:42 — TypeError: cannot read property of undefined",
      "src/utils/math.test.ts:15 — expected 4 but got NaN",
    ]);
  });

  it("parses PASS_WITH_WARNINGS as passing", () => {
    const text = `### VERIFY_RESULT

**Status:** PASS_WITH_WARNINGS

**Checks run:**
- typecheck: PASS
- lint: PASS

**New failures** (caused by recent changes):
None

**Pre-existing failures** (already failing before these changes):
- test/legacy.test.ts — flaky timeout (pre-existing)

**Scope rationale:** Minimal changes.`;

    const result = parseVerifyResult(text);
    expect(result.passed).toBe(true);
    expect(result.newFailures).toEqual([]);
  });

  it("treats missing VERIFY_RESULT block as failure", () => {
    const text = "I couldn't figure out how to run the tests.";
    const result = parseVerifyResult(text);
    expect(result.passed).toBe(false);
    expect(result.newFailures.length).toBe(1);
    expect(result.newFailures[0]).toContain("couldn't figure out");
  });

  it("treats missing status line as FAIL", () => {
    const text = `### VERIFY_RESULT

**Checks run:**
- typecheck: PASS

**New failures** (caused by recent changes):
- something broke

**Pre-existing failures** (already failing before these changes):
None

**Scope rationale:** All files.`;

    const result = parseVerifyResult(text);
    expect(result.passed).toBe(false);
    expect(result.newFailures).toEqual(["something broke"]);
  });
});
