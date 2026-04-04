import type { ExecutionMode } from "./config.js";

export type ComplexityTier = "trivial" | "small" | "medium" | "large";

export type PassDecision = "run_now" | "defer" | "skip";

export type TriageResult = {
  readonly nextTier: ComplexityTier;
  readonly completeness: PassDecision;
  readonly verify: PassDecision;
  readonly review: PassDecision;
  readonly gap: PassDecision;
  readonly reason: string;
};

export type RequestTriageResult = {
  readonly mode: ExecutionMode;
  readonly reason: string;
};

export const FULL_TRIAGE: TriageResult = {
  nextTier: "medium",
  completeness: "run_now",
  verify: "run_now",
  review: "run_now",
  gap: "run_now",
  reason: "full pipeline",
};

export const fullTriageForTier = (tier: ComplexityTier): TriageResult => ({
  ...FULL_TRIAGE,
  nextTier: tier,
});

export const REQUEST_TRIAGE_FALLBACK: RequestTriageResult = {
  mode: "sliced",
  reason: "request triage unavailable; default to sliced execution",
};

export const formatRequestTriageSummary = (result: RequestTriageResult): string =>
  `mode=${result.mode}`;

export type ComplexityTriageResult = {
  readonly tier: ComplexityTier;
  readonly reason: string;
};

export const COMPLEXITY_TRIAGE_FALLBACK: ComplexityTriageResult = {
  tier: "medium",
  reason: "complexity triage unavailable; default to medium",
};

export const shouldRunPass = (decision: PassDecision): boolean => decision === "run_now";

export const shouldDeferPass = (decision: PassDecision): boolean => decision === "defer";

export const shouldSkipPass = (decision: PassDecision): boolean => decision === "skip";
