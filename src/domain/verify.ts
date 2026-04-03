import { z } from "zod";

export type VerifyStatus = "PASS" | "FAIL" | "PASS_WITH_WARNINGS";
export type VerifyCheckStatus = "PASS" | "FAIL" | "WARN" | "SKIPPED";

export type VerifyCheck = {
  readonly check: string;
  readonly status: VerifyCheckStatus;
};

export type VerifyResult = {
  readonly status: VerifyStatus;
  readonly checks: readonly VerifyCheck[];
  readonly sliceLocalFailures: readonly string[];
  readonly outOfScopeFailures: readonly string[];
  readonly preExistingFailures: readonly string[];
  readonly runnerIssue: string | null;
  readonly retryable: boolean;
  readonly summary: string;
  readonly output: string;
  readonly valid: boolean;
};

const VerifyJsonSchema = z.object({
  status: z.enum(["PASS", "FAIL", "PASS_WITH_WARNINGS"]),
  checks: z.array(
    z.object({
      check: z.string().min(1),
      status: z.enum(["PASS", "FAIL", "WARN", "SKIPPED"]),
    }),
  ),
  sliceLocalFailures: z.array(z.string()),
  outOfScopeFailures: z.array(z.string()),
  preExistingFailures: z.array(z.string()),
  runnerIssue: z.string().nullable(),
  retryable: z.boolean(),
  summary: z.string().min(1),
});

const INVALID_VERIFY_RESULT = (
  output: string,
  summary: string,
  runnerIssue = summary,
): VerifyResult => ({
  status: "FAIL",
  checks: [],
  sliceLocalFailures: [],
  outOfScopeFailures: [],
  preExistingFailures: [],
  runnerIssue,
  retryable: false,
  summary,
  output,
  valid: false,
});

const extractVerifyJsonText = (text: string): string | null => {
  const marker = "### VERIFY_JSON";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const afterMarker = text.slice(markerIndex + marker.length).trim();
  if (!afterMarker) {
    return null;
  }

  const fenced = afterMarker.match(/^```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    return fenced[1].trim();
  }

  const jsonStart = afterMarker.indexOf("{");
  const jsonEnd = afterMarker.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    return null;
  }

  return afterMarker.slice(jsonStart, jsonEnd + 1).trim();
};

export const isVerifyPassing = (result: VerifyResult): boolean => result.status !== "FAIL";

export const parseVerifyResult = (text: string): VerifyResult => {
  const verifyJsonText = extractVerifyJsonText(text);
  if (!verifyJsonText) {
    return INVALID_VERIFY_RESULT(
      text,
      "Verifier output missing required VERIFY_JSON block",
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(verifyJsonText);
  } catch (error) {
    return INVALID_VERIFY_RESULT(
      text,
      `Verifier output contained invalid VERIFY_JSON: ${(error as Error).message}`,
    );
  }

  const parsed = VerifyJsonSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join(".") || "<root>").join(", ");
    return INVALID_VERIFY_RESULT(
      text,
      `Verifier output failed VERIFY_JSON validation: ${issues}`,
    );
  }

  return {
    ...parsed.data,
    output: text,
    valid: true,
  };
};
