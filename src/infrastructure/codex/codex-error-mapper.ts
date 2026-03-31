import type { CodexTurnError } from "./codex-notifications.js";

export type ApiErrorCategory = "retryable" | "creditExhausted" | "unauthorized" | "unknown";

export const categorizeCodexError = (err: CodexTurnError): ApiErrorCategory => {
  switch (err.code) {
    case "serverOverloaded":
    case "rateLimited":
    case "connectionFailed":
    case "connectionReset":
    case "timeout":
      return "retryable";
    case "usageLimitExceeded":
      return "creditExhausted";
    case "unauthorized":
      return "unauthorized";
    default:
      return "unknown";
  }
};
