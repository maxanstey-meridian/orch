export type TriageResult = {
  readonly runCompleteness: boolean;
  readonly runVerify: boolean;
  readonly runReview: boolean;
  readonly runGap: boolean;
  readonly reason: string;
};

export const FULL_TRIAGE: TriageResult = {
  runCompleteness: true,
  runVerify: true,
  runReview: true,
  runGap: true,
  reason: "full pipeline",
};
