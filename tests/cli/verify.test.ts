import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { isVerifyPassing, parseVerifyResult } from "#domain/verify.js";
import { buildVerifyPrompt } from "#infrastructure/plan/prompts.js";

describe("parseVerifyResult", () => {
  it("parses structured VERIFY_JSON output with ownership buckets", () => {
    const text = `Verification summary: scoped tests passed except for one local regression.

### VERIFY_JSON
\`\`\`json
{
  "status": "FAIL",
  "checks": [
    { "check": "npx vitest run tests/plan/plan-generator.test.ts", "status": "FAIL" },
    { "check": "npx tsc --noEmit", "status": "PASS" }
  ],
  "sliceLocalFailures": ["tests/plan/plan-generator.test.ts: grouped mode retry path regressed"],
  "outOfScopeFailures": [],
  "preExistingFailures": ["tests/queue/queue-store.test.ts: flaky cross-process write race"],
  "runnerIssue": null,
  "retryable": true,
  "summary": "One slice-local regression remains after the recent change."
}
\`\`\``;

    const result = parseVerifyResult(text);

    expect(result.status).toBe("FAIL");
    expect(result.checks).toEqual([
      { check: "npx vitest run tests/plan/plan-generator.test.ts", status: "FAIL" },
      { check: "npx tsc --noEmit", status: "PASS" },
    ]);
    expect(result.sliceLocalFailures).toEqual([
      "tests/plan/plan-generator.test.ts: grouped mode retry path regressed",
    ]);
    expect(result.outOfScopeFailures).toEqual([]);
    expect(result.preExistingFailures).toEqual([
      "tests/queue/queue-store.test.ts: flaky cross-process write race",
    ]);
    expect(result.runnerIssue).toBeNull();
    expect(result.retryable).toBe(true);
    expect(result.summary).toBe("One slice-local regression remains after the recent change.");
    expect(result.output).toBe(text);
    expect(result.valid).toBe(true);
    expect(isVerifyPassing(result)).toBe(false);
  });

  it("fails closed when VERIFY_JSON is missing", () => {
    const text = "No findings. Everything looks good.";
    const result = parseVerifyResult(text);

    expect(result.status).toBe("FAIL");
    expect(result.valid).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.sliceLocalFailures).toEqual([]);
    expect(result.outOfScopeFailures).toEqual([]);
    expect(result.preExistingFailures).toEqual([]);
    expect(result.runnerIssue).toContain("missing required VERIFY_JSON block");
    expect(isVerifyPassing(result)).toBe(false);
  });

  it("fails closed when VERIFY_JSON is malformed", () => {
    const text = `Verification summary.

### VERIFY_JSON
\`\`\`json
{ "status": "PASS", "checks":
\`\`\``;
    const result = parseVerifyResult(text);

    expect(result.status).toBe("FAIL");
    expect(result.valid).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.runnerIssue).toContain("invalid VERIFY_JSON");
  });

  it("fails closed when VERIFY_JSON is well-formed JSON but violates the required schema", () => {
    const text = `Verification summary.

### VERIFY_JSON
\`\`\`json
{
  "status": "FAIL",
  "checks": [
    { "check": "npx vitest run", "status": "FAIL" }
  ],
  "sliceLocalFailures": [],
  "outOfScopeFailures": [],
  "preExistingFailures": [],
  "runnerIssue": null,
  "retryable": "yes"
}
\`\`\``;
    const result = parseVerifyResult(text);

    expect(result.status).toBe("FAIL");
    expect(result.valid).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.runnerIssue).toContain("failed VERIFY_JSON validation");
    expect(result.runnerIssue).toContain("retryable");
    expect(result.runnerIssue).toContain("summary");
  });

  it("preserves slice-local, out-of-scope, and pre-existing failures independently of retryable", () => {
    const text = `Verification summary: external failure only.

### VERIFY_JSON
{
  "status": "FAIL",
  "checks": [
    { "check": "npx vitest run", "status": "FAIL" }
  ],
  "sliceLocalFailures": [],
  "outOfScopeFailures": ["packages/api: unrelated failing migration test"],
  "preExistingFailures": ["tests/queue/queue-store.test.ts: flaky cross-process write race"],
  "runnerIssue": "Vitest worker hung during one rerun.",
  "retryable": true,
  "summary": "Verification failed, but the current execution unit does not own the failure."
}`;

    const result = parseVerifyResult(text);

    expect(result.status).toBe("FAIL");
    expect(result.sliceLocalFailures).toEqual([]);
    expect(result.outOfScopeFailures).toEqual([
      "packages/api: unrelated failing migration test",
    ]);
    expect(result.preExistingFailures).toEqual([
      "tests/queue/queue-store.test.ts: flaky cross-process write race",
    ]);
    expect(result.runnerIssue).toBe("Vitest worker hung during one rerun.");
    expect(result.retryable).toBe(true);
    expect(isVerifyPassing(result)).toBe(false);
  });

  it("treats PASS_WITH_WARNINGS as passing only through structured status", () => {
    const text = `Verification summary: changes are clean, but unrelated flake remains.

### VERIFY_JSON
{
  "status": "PASS_WITH_WARNINGS",
  "checks": [
    { "check": "npx vitest run tests/plan", "status": "PASS" }
  ],
  "sliceLocalFailures": [],
  "outOfScopeFailures": [],
  "preExistingFailures": ["tests/queue/queue-store.test.ts: flaky cross-process write race"],
  "runnerIssue": null,
  "retryable": false,
  "summary": "Current execution unit is clean; warning is pre-existing."
}`;

    const result = parseVerifyResult(text);

    expect(result.status).toBe("PASS_WITH_WARNINGS");
    expect(result.preExistingFailures).toEqual([
      "tests/queue/queue-store.test.ts: flaky cross-process write race",
    ]);
    expect(isVerifyPassing(result)).toBe(true);
  });

  it("verify prompt requires a short human summary and the structured VERIFY_JSON block", () => {
    const prompt = buildVerifyPrompt("abc123", "Group Core", "builder fixed the shared spec");

    expect(prompt).toContain("short human summary");
    expect(prompt).toContain("### VERIFY_JSON");
    expect(prompt).toContain('"sliceLocalFailures"');
    expect(prompt).toContain('"runnerIssue"');
    expect(prompt).toContain("sliceLocalFailures");
    expect(prompt).toContain("Run the verification commands required by your system prompt and project config");
  });

  it("verify skill requires the human summary plus mandatory VERIFY_JSON contract", () => {
    const skill = readFileSync("skills/verify.md", "utf8");

    expect(skill).toContain("### VERIFY_JSON");
    expect(skill).toContain("sliceLocalFailures");
    expect(skill).toContain("The `### VERIFY_JSON` block is mandatory.");
  });
});
