import { describe, it, expect } from "vitest";
import { FULL_TRIAGE, formatRequestTriageSummary } from "#domain/triage.js";
import { buildTriagePrompt, parseTriageResult } from "#infrastructure/diff-triage.js";
import {
  buildRequestTriagePrompt,
  parseRequestTriageResult,
} from "#infrastructure/request-triage.js";

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

  it("returns FULL_TRIAGE when the JSON is malformed", () => {
    expect(
      parseTriageResult(`\`\`\`json
{"completeness": true,
\`\`\``),
    ).toEqual(FULL_TRIAGE);
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

  it("includes the classifier dimensions and stage-decision guidance", () => {
    const prompt = buildTriagePrompt("diff --git a/file.ts b/file.ts");

    expect(prompt).toContain("file count");
    expect(prompt).toContain("scope of the change");
    expect(prompt).toContain("nature of the change");
    expect(prompt).toContain("cascade risk across adjacent code paths");
    expect(prompt).toContain(
      "Decide whether the pipeline should run completeness, verify, review, and gap analysis",
    );
  });
});

describe("parseRequestTriageResult", () => {
  it("parses direct request triage JSON", () => {
    expect(
      parseRequestTriageResult('{"mode":"direct","reason":"bounded local change"}'),
    ).toEqual({
      mode: "direct",
      reason: "bounded local change",
    });
  });

  it.each([
    {
      text: '{"mode":"grouped","reason":"meaningful intermediate units"}',
      expected: { mode: "grouped", reason: "meaningful intermediate units" },
    },
    {
      text: '{"mode":"sliced","reason":"resume granularity matters"}',
      expected: { mode: "sliced", reason: "resume granularity matters" },
    },
  ])("accepts valid request triage JSON for $expected.mode", ({ text, expected }) => {
    expect(parseRequestTriageResult(text)).toEqual(expected);
  });

  it.each([
    "",
    "definitely not JSON",
    '{"mode":"direct",',
    '{"mode":"direct"}',
    '{"reason":"missing mode"}',
    '{"mode":true,"reason":"wrong mode type"}',
    '{"mode":"direct","reason":false}',
    '{"mode":"direct","reason":"extra key","extra":true}',
    'Here is the result: {"mode":"direct","reason":"wrapped in prose"}',
  ])("falls back to sliced for invalid request triage input: %s", (text) => {
    expect(parseRequestTriageResult(text)).toEqual({
      mode: "sliced",
      reason: expect.any(String),
    });
  });
});

describe("formatRequestTriageSummary", () => {
  it("formats the request triage mode for operator-facing summaries", () => {
    expect(
      formatRequestTriageSummary({
        mode: "grouped",
        reason: "shared dependency ordering across several units",
      }),
    ).toBe("mode=grouped");
  });
});

describe("buildRequestTriagePrompt", () => {
  it("requires raw JSON only and explains the direct/grouped/sliced boundaries", () => {
    const request = "Add execution mode triage before bootstrap.";
    const prompt = buildRequestTriagePrompt(request);

    expect(prompt).toContain(request);
    expect(prompt).toContain("Output ONLY raw JSON");
    expect(prompt).toContain('"mode"');
    expect(prompt).toContain('"reason"');
    expect(prompt).toContain("direct");
    expect(prompt).toContain("grouped");
    expect(prompt).toContain("sliced");
    expect(prompt).toContain("breadth of change");
    expect(prompt).toContain("dependency ordering");
    expect(prompt).toContain("meaningful intermediate units");
    expect(prompt).toContain("slice-granularity resume value");
  });
});
