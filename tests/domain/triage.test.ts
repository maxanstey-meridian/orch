import { describe, it, expect } from "vitest";
import {
  COMPLEXITY_TRIAGE_FALLBACK,
  FULL_TRIAGE,
  formatRequestTriageSummary,
} from "#domain/triage.js";
import {
  buildComplexityTriagePrompt,
  parseComplexityTriageResult,
} from "#infrastructure/complexity-triage.js";
import { buildTriagePrompt, parseTriageResult } from "#infrastructure/diff-triage.js";
import {
  buildRequestTriagePrompt,
  parseRequestTriageResult,
} from "#infrastructure/request-triage.js";

describe("FULL_TRIAGE", () => {
  it("enables every pipeline stage with the default reason", () => {
    expect(FULL_TRIAGE).toEqual({
      completeness: "run_now",
      verify: "run_now",
      review: "run_now",
      gap: "run_now",
      reason: "full pipeline",
    });
  });
});

describe("parseTriageResult", () => {
  it("maps tri-state triage JSON fields into the domain result shape", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          completeness: "run_now",
          verify: "defer",
          review: "skip",
          gap: "run_now",
          reason: "mixed pipeline",
        }),
      ),
    ).toEqual({
      completeness: "run_now",
      verify: "defer",
      review: "skip",
      gap: "run_now",
      reason: "mixed pipeline",
    });
  });

  it("maps legacy boolean triage fields into the tri-state domain result shape", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          completeness: true,
          verify: false,
          review: true,
          gap: false,
          reason: "legacy pipeline",
        }),
      ),
    ).toEqual({
      completeness: "run_now",
      verify: "skip",
      review: "run_now",
      gap: "skip",
      reason: "legacy pipeline",
    });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    expect(
      parseTriageResult(`Here is the classifier result:

{
  "completeness": "skip",
  "verify": "run_now",
  "review": "defer",
  "gap": "skip",
  "reason": "targeted review"
}`),
    ).toEqual({
      completeness: "skip",
      verify: "run_now",
      review: "defer",
      gap: "skip",
      reason: "targeted review",
    });
  });

  it("extracts JSON wrapped in markdown code fences", () => {
    expect(
      parseTriageResult(`\`\`\`json
{
  "completeness": "run_now",
  "verify": "run_now",
  "review": "skip",
  "gap": "defer",
  "reason": "verify only"
}
\`\`\``),
    ).toEqual({
      completeness: "run_now",
      verify: "run_now",
      review: "skip",
      gap: "defer",
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
          completeness: "run_now",
          verify: "skip",
          review: "run_now",
          reason: "partial",
        }),
      ),
    ).toEqual(FULL_TRIAGE);
  });

  it("returns FULL_TRIAGE when fields have the wrong primitive types", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          completeness: "run_now",
          verify: false,
          review: "run_now",
          gap: "skip",
          reason: "typed wrong",
        }),
      ),
    ).toEqual(FULL_TRIAGE);
  });
});

describe("buildTriagePrompt", () => {
  const input = {
    mode: "sliced" as const,
    unitKind: "slice" as const,
    diffStats: { added: 10, removed: 2, total: 12 },
    reviewThreshold: 150,
    finalBoundary: false,
    moreUnitsInGroup: true,
    pending: {
      verify: false,
      completeness: true,
      review: false,
      gap: true,
    },
  };

  it("includes the diff text and asks the model to classify the change", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
+const changed = true;`;
    const prompt = buildTriagePrompt({ ...input, diff });

    expect(prompt).toContain(diff);
    expect(prompt.toLowerCase()).toMatch(/classif(y|ier)/);
  });

  it("lists the required JSON output keys", () => {
    const prompt = buildTriagePrompt({ ...input, diff: "diff --git a/file.ts b/file.ts" });

    expect(prompt).toContain("completeness");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("review");
    expect(prompt).toContain("gap");
    expect(prompt).toContain("reason");
  });

  it("requires raw JSON output without commentary or code fences", () => {
    const prompt = buildTriagePrompt({ ...input, diff: "diff --git a/file.ts b/file.ts" });

    expect(prompt).toContain("Output ONLY the raw JSON object");
    expect(prompt).toContain("No markdown code fences");
    expect(prompt).toContain("no commentary");
  });

  it("includes the classifier dimensions and stage-decision guidance", () => {
    const prompt = buildTriagePrompt({ ...input, diff: "diff --git a/file.ts b/file.ts" });

    expect(prompt).toContain("file count");
    expect(prompt).toContain("scope of the change");
    expect(prompt).toContain("nature of the change");
    expect(prompt).toContain("cascade risk across adjacent code paths");
    expect(prompt).toContain(
      "which expensive passes should run now",
    );
    expect(prompt).toContain("deferred");
    expect(prompt).not.toContain("NEXT execution unit");
  });
});

describe("parseComplexityTriageResult", () => {
  it("parses valid complexity triage JSON", () => {
    expect(
      parseComplexityTriageResult(
        JSON.stringify({
          tier: "small",
          reason: "single abstraction with a modest test surface",
        }),
      ),
    ).toEqual({
      tier: "small",
      reason: "single abstraction with a modest test surface",
    });
  });

  it("falls back when the response is empty", () => {
    expect(parseComplexityTriageResult("   \n\t  ")).toEqual({
      tier: COMPLEXITY_TRIAGE_FALLBACK.tier,
      reason: `${COMPLEXITY_TRIAGE_FALLBACK.reason}: empty response`,
    });
  });

  it("falls back when the response is malformed JSON", () => {
    expect(parseComplexityTriageResult('{"tier":"small",')).toEqual({
      tier: COMPLEXITY_TRIAGE_FALLBACK.tier,
      reason: `${COMPLEXITY_TRIAGE_FALLBACK.reason}: invalid JSON`,
    });
  });

  it("falls back when the response JSON does not satisfy the schema", () => {
    expect(
      parseComplexityTriageResult(
        JSON.stringify({
          tier: "huge",
          reason: "",
        }),
      ),
    ).toEqual({
      tier: COMPLEXITY_TRIAGE_FALLBACK.tier,
      reason: `${COMPLEXITY_TRIAGE_FALLBACK.reason}: invalid schema`,
    });
  });
});

describe("buildComplexityTriagePrompt", () => {
  it("includes the request and preserves the complexity classification contract", () => {
    const request = "Refactor triage routing and add grouped execution coverage.";
    const prompt = buildComplexityTriagePrompt(request);

    expect(prompt).toContain(request);
    expect(prompt).toContain("trivial");
    expect(prompt).toContain("small");
    expect(prompt).toContain("medium");
    expect(prompt).toContain("large");
    expect(prompt).toContain("Err toward smaller tiers when in doubt.");
    expect(prompt).toContain("Output ONLY raw JSON.");
    expect(prompt).toContain("No markdown, no prose, no code fences, no surrounding text.");
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
    expect(prompt).toContain("dependency ordering");
    expect(prompt).toContain("meaningful intermediate deliverables");
    expect(prompt).toContain("slice-granularity resume value");
  });
});
