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
      nextTier: "medium",
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
          nextTier: "large",
          completeness: "run_now",
          verify: "defer",
          review: "skip",
          gap: "run_now",
          reason: "mixed pipeline",
        }),
        "medium",
      ),
    ).toEqual({
      nextTier: "large",
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
        "small",
      ),
    ).toEqual({
      nextTier: "small",
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
  "nextTier": "trivial",
  "completeness": "skip",
  "verify": "run_now",
  "review": "defer",
  "gap": "skip",
  "reason": "targeted review"
}`, "medium"),
    ).toEqual({
      nextTier: "trivial",
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
  "nextTier": "medium",
  "completeness": "run_now",
  "verify": "run_now",
  "review": "skip",
  "gap": "defer",
  "reason": "verify only"
}
\`\`\``, "small"),
    ).toEqual({
      nextTier: "medium",
      completeness: "run_now",
      verify: "run_now",
      review: "skip",
      gap: "defer",
      reason: "verify only",
    });
  });

  it("returns FULL_TRIAGE when the input is garbage text", () => {
    expect(parseTriageResult("definitely not JSON", "medium")).toEqual(FULL_TRIAGE);
  });

  it("returns FULL_TRIAGE when the JSON is malformed", () => {
    expect(
      parseTriageResult(`\`\`\`json
{"completeness": true,
\`\`\``, "large"),
    ).toEqual({
      ...FULL_TRIAGE,
      nextTier: "large",
    });
  });

  it("returns FULL_TRIAGE when required fields are missing", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          nextTier: "small",
          completeness: "run_now",
          verify: "skip",
          review: "run_now",
          reason: "partial",
        }),
        "trivial",
      ),
    ).toEqual({
      ...FULL_TRIAGE,
      nextTier: "trivial",
    });
  });

  it("returns FULL_TRIAGE when fields have the wrong primitive types", () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          nextTier: "medium",
          completeness: "run_now",
          verify: false,
          review: "run_now",
          gap: "skip",
          reason: "typed wrong",
        }),
        "small",
      ),
    ).toEqual({
      ...FULL_TRIAGE,
      nextTier: "small",
    });
  });
});

describe("buildTriagePrompt", () => {
  const input = {
    mode: "sliced" as const,
    unitKind: "slice" as const,
    currentTier: "medium" as const,
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

    expect(prompt).toContain("nextTier");
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
    expect(prompt).toContain("NEXT execution unit");
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
