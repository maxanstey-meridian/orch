import { describe, it, expect } from "vitest";
import { detectApiError } from "#domain/api-errors.js";
import type { AgentResult } from "#domain/agent-types.js";

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test",
  ...overrides,
});

describe("detectApiError", () => {
  it("classifies 529 overloaded as retryable", () => {
    const result = makeResult({ exitCode: 1, resultText: "Error 529 overloaded" });
    const error = detectApiError(result, "");
    expect(error).toEqual({ kind: "overloaded", retryable: true });
  });

  it("classifies rate limit as retryable", () => {
    const result = makeResult({ exitCode: 1, resultText: "rate limit exceeded" });
    const error = detectApiError(result, "");
    expect(error).toEqual({ kind: "rate-limited", retryable: true });
  });

  it("classifies credit exhaustion as terminal", () => {
    const result = makeResult({ exitCode: 1, resultText: "credit exhausted for this account" });
    const error = detectApiError(result, "");
    expect(error).toEqual({ kind: "credit-exhausted", retryable: false });
  });

  it("classifies hit-your-limit messages without depending on a parsed reset time", () => {
    const result = makeResult({
      exitCode: 1,
      resultText: "You've hit your limit · resets 10am (Europe/London)",
    });
    const error = detectApiError(result, "");
    expect(error).toEqual({
      kind: "credit-exhausted",
      retryable: false,
    });
  });

  it("classifies hit-your-limit messages when they only arrive in assistantText", () => {
    const result = makeResult({
      exitCode: 1,
      assistantText: "You've hit your limit · resets 10am (Europe/London)",
      resultText: "",
    });
    const error = detectApiError(result, "");
    expect(error).toEqual({
      kind: "credit-exhausted",
      retryable: false,
    });
  });

  it("returns null for unknown non-zero exits", () => {
    const result = makeResult({ exitCode: 1, resultText: "something unexpected happened" });
    const error = detectApiError(result, "");
    expect(error).toBeNull();
  });

  it("returns null on successful exit regardless of text", () => {
    const result = makeResult({ exitCode: 0, resultText: "529 overloaded" });
    expect(detectApiError(result, "rate limit")).toBeNull();
  });
});
