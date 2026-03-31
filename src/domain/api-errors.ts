import type { AgentResult } from "./agent-types.js";

export type ApiError = {
  readonly kind: "overloaded" | "rate-limited" | "credit-exhausted" | "unknown";
  readonly retryable: boolean;
};

export const detectApiError = (result: AgentResult, stderr: string): ApiError | null => {
  if (result.exitCode === 0) {
    return null;
  }

  const combined = `${result.resultText}\n${stderr}`;

  if (/529|overloaded/i.test(combined)) {
    return { kind: "overloaded", retryable: true };
  }

  if (/rate\s+limit/i.test(combined)) {
    return { kind: "rate-limited", retryable: true };
  }

  if (/credit/i.test(combined) && /(exhaust|limit|exceed)/i.test(combined)) {
    return { kind: "credit-exhausted", retryable: false };
  }

  if (/quota/i.test(combined) && /(exceed|limit)/i.test(combined)) {
    return { kind: "credit-exhausted", retryable: false };
  }

  if (/usage\s+limit/i.test(combined)) {
    return { kind: "credit-exhausted", retryable: false };
  }

  return null;
};
