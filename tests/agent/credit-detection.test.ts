import { describe, it, expect } from "vitest";
import { detectCreditExhaustion } from "../../src/agent/credit-detection.js";
import type { AgentResult } from "../../src/agent/agent.js";

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test",
  ...overrides,
});

describe("detectCreditExhaustion", () => {
  it("returns null when no pattern matches", () => {
    const result = makeResult({ resultText: "All good, task complete." });
    expect(detectCreditExhaustion(result, "")).toBeNull();
  });

  it('detects "rate limit" in resultText', () => {
    const result = makeResult({ resultText: "Error: rate limit exceeded", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).toEqual({ kind: "rejected", message: "Rate limited. Wait and retry." });
  });

  it('detects "rate limit" in stderr', () => {
    const result = makeResult({ exitCode: 1 });
    const signal = detectCreditExhaustion(result, "rate limit hit");
    expect(signal).toEqual({ kind: "rejected", message: "Rate limited. Wait and retry." });
  });

  it('detects "credit exhausted"', () => {
    const result = makeResult({ resultText: "credit exhausted for this account", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).toEqual({ kind: "rejected", message: "Credits exhausted." });
  });

  it('detects "credit limit"', () => {
    const result = makeResult({ resultText: "You have hit your credit limit.", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).toEqual({ kind: "rejected", message: "Credits exhausted." });
  });

  it('detects "credit exceeded"', () => {
    const result = makeResult({ resultText: "credit exceeded", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).toEqual({ kind: "rejected", message: "Credits exhausted." });
  });

  it('detects "quota exceeded"', () => {
    const result = makeResult({ resultText: "API quota exceeded", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).toEqual({ kind: "rejected", message: "Quota exceeded." });
  });

  it('detects "quota limit"', () => {
    const result = makeResult({ resultText: "quota limit reached", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).toEqual({ kind: "rejected", message: "Quota exceeded." });
  });

  it('detects "usage limit"', () => {
    const result = makeResult({ resultText: "usage limit reached", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).toEqual({ kind: "rejected", message: "Usage limit reached." });
  });

  it("is case-insensitive", () => {
    const result = makeResult({ resultText: "RATE LIMIT exceeded", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).not.toBeNull();
    expect(signal!.message).toBe("Rate limited. Wait and retry.");
  });

  it('returns "rejected" when assistantText is empty', () => {
    const result = makeResult({ resultText: "rate limit", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal!.kind).toBe("rejected");
  });

  it('returns "mid-response" when assistantText is non-empty and exit code is non-zero', () => {
    const result = makeResult({
      assistantText: "I was working on...",
      resultText: "rate limit",
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, "");
    expect(signal!.kind).toBe("mid-response");
  });

  it("returns null when exit code is zero even if pattern matches", () => {
    // Exit 0 means the agent completed normally — pattern match is incidental, not a credit issue
    const result = makeResult({
      assistantText: "Some output",
      resultText: "rate limit warning",
      exitCode: 0,
    });
    expect(detectCreditExhaustion(result, "")).toBeNull();
  });

  it("detects signal in stderr when resultText has unrelated content", () => {
    const result = makeResult({ resultText: "all good here", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "rate limit");
    expect(signal).toEqual({ kind: "rejected", message: "Rate limited. Wait and retry." });
  });

  it("returns null when both resultText and stderr are empty with non-zero exit", () => {
    const result = makeResult({ exitCode: 1 });
    expect(detectCreditExhaustion(result, "")).toBeNull();
  });

  it("returns mid-response when pattern is in stderr only and assistantText is non-empty", () => {
    const result = makeResult({ assistantText: "partial work", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "credit exhausted");
    expect(signal).toEqual({ kind: "mid-response", message: "Credits exhausted." });
  });

  it("returns null when exitCode is 0 and assistantText is empty even if pattern matches", () => {
    const result = makeResult({ resultText: "rate limit hit", exitCode: 0 });
    expect(detectCreditExhaustion(result, "")).toBeNull();
  });

  it("treats whitespace-only assistantText as non-empty (mid-response)", () => {
    const result = makeResult({
      assistantText: "   ",
      resultText: "rate limit",
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, "");
    expect(signal!.kind).toBe("mid-response");
  });

  it('detects credit exhaustion when "credit" is in resultText and "exhausted" is in stderr', () => {
    const result = makeResult({ resultText: "credit issue detected", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "request exhausted");
    expect(signal).toEqual({ kind: "rejected", message: "Credits exhausted." });
  });

  it("picks the first matching pattern when multiple match", () => {
    const result = makeResult({
      resultText: "rate limit and credit exhausted and quota exceeded",
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, "");
    // "rate limit" is the first pattern
    expect(signal!.message).toBe("Rate limited. Wait and retry.");
  });

  it("matches across resultText/stderr join boundary (pins concatenation behavior)", () => {
    // "rate" at end of resultText + "limit" at start of stderr
    // The implementation concatenates with \n and \s+ matches newlines
    const result = makeResult({ resultText: "some rate", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "limit reached");
    // This IS a match due to concatenation — pinning as intentional
    expect(signal).toEqual({ kind: "rejected", message: "Rate limited. Wait and retry." });
  });

  it("returns non-null signal for exit(2) path (rate limit with exitCode 1)", () => {
    const result = makeResult({ resultText: "rate limit exceeded", exitCode: 1 });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).not.toBeNull();
  });

  it("mid-response signal is returned when assistantText is non-empty", () => {
    const result = makeResult({
      assistantText: "I was working on the implementation...",
      resultText: "credit exhausted",
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).not.toBeNull();
    expect(signal!.kind).toBe("mid-response");
  });

  it("rejected signal (empty assistantText) does NOT trigger mid-response log path", () => {
    const result = makeResult({
      assistantText: "",
      resultText: "credit exhausted",
      exitCode: 1,
    });
    const signal = detectCreditExhaustion(result, "");
    expect(signal).not.toBeNull();
    expect(signal!.kind).toBe("rejected");
  });
});
