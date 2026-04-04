import type { ExecutionMode } from "./config.js";

export type TriageResult = {
  readonly runCompleteness: boolean;
  readonly runVerify: boolean;
  readonly runReview: boolean;
  readonly runGap: boolean;
  readonly reason: string;
};

export type RequestTriageResult = {
  readonly mode: ExecutionMode;
  readonly reason: string;
};

export const FULL_TRIAGE: TriageResult = {
  runCompleteness: true,
  runVerify: true,
  runReview: true,
  runGap: true,
  reason: "full pipeline",
};

export const REQUEST_TRIAGE_FALLBACK: RequestTriageResult = {
  mode: "sliced",
  reason: "request triage unavailable; default to sliced execution",
};

export const formatRequestTriageSummary = (result: RequestTriageResult): string =>
  `mode=${result.mode}`;

export type ComplexityTier = "trivial" | "small" | "medium" | "large";

export type ComplexityTriageResult = {
  readonly tier: ComplexityTier;
  readonly reason: string;
};

export const COMPLEXITY_TRIAGE_FALLBACK: ComplexityTriageResult = {
  tier: "medium",
  reason: "complexity triage unavailable; default to medium",
};
