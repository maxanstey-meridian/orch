import { describe, it, expect } from "vitest";
import { FULL_TRIAGE } from "../../src/domain/triage.js";
import { buildTriagePrompt, parseTriageResult } from "../../src/infrastructure/diff-triage.js";

describe("FULL_TRIAGE", () => {
  it("enables every pipeline stage with the default reason", () => {
    expect(FULL_TRIAGE).toEqual({
      runCompleteness: true,
      runVerify: true,
      runReview: true,
      runGap: true,
      reason: "full pipeline",
    });
  });
});

describe("parseTriageResult", () => {
  it("maps triage JSON fields into the domain result shape", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          completeness: true,
          verify: false,
          review: true,
          gap: false,
          reason: "mixed pipeline",
        }),
      ),
    ).toEqual({
      runCompleteness: true,
      runVerify: false,
      runReview: true,
      runGap: false,
      reason: "mixed pipeline",
    });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    expect(
      parseTriageResult(`Here is the classifier result:

{
  "completeness": false,
  "verify": true,
  "review": false,
  "gap": true,
  "reason": "targeted review"
}`),
    ).toEqual({
      runCompleteness: false,
      runVerify: true,
      runReview: false,
      runGap: true,
      reason: "targeted review",
    });
  });

  it("extracts JSON wrapped in markdown code fences", () => {
    expect(
      parseTriageResult(`\`\`\`json
{
  "completeness": true,
  "verify": true,
  "review": false,
  "gap": false,
  "reason": "verify only"
}
\`\`\``),
    ).toEqual({
      runCompleteness: true,
      runVerify: true,
      runReview: false,
      runGap: false,
      reason: "verify only",
    });
  });

  it("returns FULL_TRIAGE when the input is garbage text", () => {
    expect(parseTriageResult("definitely not JSON")).toEqual(FULL_TRIAGE);
  });

  it("returns FULL_TRIAGE when required fields are missing", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          completeness: true,
          verify: false,
          review: true,
          reason: "partial",
        }),
      ),
    ).toEqual(FULL_TRIAGE);
  });

  it("returns FULL_TRIAGE when fields have the wrong primitive types", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          completeness: true,
          verify: "false",
          review: true,
          gap: false,
          reason: "typed wrong",
        }),
      ),
    ).toEqual(FULL_TRIAGE);
  });
});

describe("buildTriagePrompt", () => {
  it("includes the diff text and asks the model to classify the change", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
+const changed = true;`;
    const prompt = buildTriagePrompt(diff);

    expect(prompt).toContain(diff);
    expect(prompt.toLowerCase()).toMatch(/classif(y|ier)/);
  });

  it("lists the required JSON output keys", () => {
    const prompt = buildTriagePrompt("diff --git a/file.ts b/file.ts");

    expect(prompt).toContain("completeness");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("review");
    expect(prompt).toContain("gap");
    expect(prompt).toContain("reason");
  });

  it("requires raw JSON output without commentary or code fences", () => {
    const prompt = buildTriagePrompt("diff --git a/file.ts b/file.ts");

    expect(prompt).toContain("Output ONLY the raw JSON object");
    expect(prompt).toContain("No markdown code fences");
    expect(prompt).toContain("no commentary");
  });
});
