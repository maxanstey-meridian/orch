import type { AgentResult } from "#domain/agent-types.js";
import { collectAgentFailureText, detectApiError } from "#domain/api-errors.js";

export type CreditSignal = {
  readonly kind: "mid-response" | "rejected";
  readonly message: string;
};

const messageForApiError = (
  kind: "rate-limited" | "credit-exhausted",
  combined: string,
): string => {
  if (kind === "rate-limited") {
    return "Rate limited. Wait and retry.";
  }
  if (/quota/i.test(combined) && /(exceed|limit)/i.test(combined)) {
    return "Quota exceeded.";
  }
  if (/usage\s+limit/i.test(combined) || /hit\s+your\s+limit/i.test(combined)) {
    return "Usage limit reached.";
  }
  return "Credits exhausted.";
};

export const detectCreditExhaustion = (
  result: AgentResult,
  stderr: string,
): CreditSignal | null => {
  const combined = collectAgentFailureText(result, stderr);
  const apiError = detectApiError(result, stderr);
  if (!apiError || (apiError.kind !== "rate-limited" && apiError.kind !== "credit-exhausted")) {
    return null;
  }

  const kind = result.assistantText.length > 0 ? ("mid-response" as const) : ("rejected" as const);

  return { kind, message: messageForApiError(apiError.kind, combined) };
};
