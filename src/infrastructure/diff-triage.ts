import { FULL_TRIAGE, type TriageResult } from "#domain/triage.js";

type ParsedTriageResult = {
  readonly completeness: boolean;
  readonly verify: boolean;
  readonly review: boolean;
  readonly gap: boolean;
  readonly reason: string;
};

const isParsedTriageResult = (value: unknown): value is ParsedTriageResult => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const triage = value as Record<string, unknown>;
  return (
    typeof triage.completeness === "boolean" &&
    typeof triage.verify === "boolean" &&
    typeof triage.review === "boolean" &&
    typeof triage.gap === "boolean" &&
    typeof triage.reason === "string"
  );
};

const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return text.slice(start, end + 1);
};

export const buildTriagePrompt = (
  diff: string,
): string => `You are a change classifier for a TDD orchestration pipeline.

Classify the diff below by:
- file count
- scope of the change
- nature of the change
- cascade risk across adjacent code paths

Decide whether the pipeline should run completeness, verify, review, and gap analysis for this change.

Return a JSON object with exactly these keys:
- completeness
- verify
- review
- gap
- reason

Use booleans for the first four fields and a short string for reason.
Output ONLY the raw JSON object. No markdown code fences, no commentary, no explanation before or after.

## Diff
${diff}`;

export const parseTriageResult = (text: string): TriageResult => {
  try {
    const json = extractJsonObject(text);
    if (json === null) {
      return FULL_TRIAGE;
    }

    const parsed = JSON.parse(json) as unknown;
    if (!isParsedTriageResult(parsed)) {
      return FULL_TRIAGE;
    }

    return {
      runCompleteness: parsed.completeness,
      runVerify: parsed.verify,
      runReview: parsed.review,
      runGap: parsed.gap,
      reason: parsed.reason,
    };
  } catch {
    return FULL_TRIAGE;
  }
};
