import type { Phase } from "./phase.js";

export type StartPlanning = { readonly kind: "StartPlanning"; readonly sliceNumber: number };
export type PlanReady = { readonly kind: "PlanReady"; readonly planText: string };
export type PlanAccepted = { readonly kind: "PlanAccepted" };
export type PlanRejected = { readonly kind: "PlanRejected" };
export type ExecutionDone = { readonly kind: "ExecutionDone" };
export type VerifyPassed = { readonly kind: "VerifyPassed" };
export type VerifyFailed = { readonly kind: "VerifyFailed" };
export type CompletenessOk = { readonly kind: "CompletenessOk" };
export type CompletenessIssues = { readonly kind: "CompletenessIssues" };
export type ReviewClean = { readonly kind: "ReviewClean" };
export type ReviewIssues = { readonly kind: "ReviewIssues" };
export type SliceComplete = { readonly kind: "SliceComplete" };
export type StartGap = { readonly kind: "StartGap"; readonly groupName: string };
export type GapDone = { readonly kind: "GapDone" };
export type StartFinalPasses = { readonly kind: "StartFinalPasses" };
export type StartReview = { readonly kind: "StartReview"; readonly sliceNumber: number };
export type AllPassesDone = { readonly kind: "AllPassesDone" };

export type PhaseEvent =
  | StartPlanning
  | PlanReady
  | PlanAccepted
  | PlanRejected
  | ExecutionDone
  | VerifyPassed
  | VerifyFailed
  | CompletenessOk
  | CompletenessIssues
  | ReviewClean
  | ReviewIssues
  | SliceComplete
  | StartGap
  | GapDone
  | StartFinalPasses
  | StartReview
  | AllPassesDone;

export const transition = (current: Phase, event: PhaseEvent): Phase => {
  switch (current.kind) {
    case "Idle":
      switch (event.kind) {
        case "StartPlanning":
          return { kind: "Planning", sliceNumber: event.sliceNumber, attempt: 1 };
        case "StartGap":
          return { kind: "GapAnalysis", groupName: event.groupName };
        case "StartFinalPasses":
          return { kind: "FinalPasses", passIndex: 0 };
        case "StartReview":
          return { kind: "Reviewing", sliceNumber: event.sliceNumber, cycle: 1 };
      }
      break;
    case "Planning":
      switch (event.kind) {
        case "PlanReady":
          return {
            kind: "Gated",
            sliceNumber: current.sliceNumber,
            planText: event.planText,
            attempt: current.attempt,
          };
      }
      break;
    case "Gated":
      switch (event.kind) {
        case "PlanAccepted":
          return {
            kind: "Executing",
            sliceNumber: current.sliceNumber,
            planText: current.planText,
          };
        case "PlanRejected":
          return {
            kind: "Planning",
            sliceNumber: current.sliceNumber,
            attempt: current.attempt + 1,
          };
      }
      break;
    case "Executing":
      switch (event.kind) {
        case "ExecutionDone":
          return { kind: "CompletenessCheck", sliceNumber: current.sliceNumber };
      }
      break;
    case "CompletenessCheck":
      switch (event.kind) {
        case "CompletenessOk":
          return { kind: "Verifying", sliceNumber: current.sliceNumber };
        case "CompletenessIssues":
          return { kind: "Executing", sliceNumber: current.sliceNumber, planText: null };
      }
      break;
    case "Verifying":
      switch (event.kind) {
        case "VerifyPassed":
          return { kind: "Reviewing", sliceNumber: current.sliceNumber, cycle: 1 };
        case "VerifyFailed":
          return { kind: "Executing", sliceNumber: current.sliceNumber, planText: null };
      }
      break;
    case "Reviewing":
      switch (event.kind) {
        case "ReviewClean":
          return { kind: "Idle" };
        case "ReviewIssues":
          return { kind: "Reviewing", sliceNumber: current.sliceNumber, cycle: current.cycle + 1 };
        case "SliceComplete":
          return { kind: "Idle" };
      }
      break;
    case "GapAnalysis":
      switch (event.kind) {
        case "GapDone":
          return { kind: "Idle" };
      }
      break;
    case "FinalPasses":
      switch (event.kind) {
        case "AllPassesDone":
          return { kind: "Complete" };
      }
      break;
    case "Complete":
      break;
  }
  throw new Error(`Illegal transition: ${current.kind} + ${event.kind}`);
};

export const canSkip = (
  phase: Phase,
  config: { skills: { plan: string | null; verify: string | null; gap: string | null } },
): boolean => {
  switch (phase.kind) {
    case "Planning":
      return config.skills.plan === null;
    case "Verifying":
      return config.skills.verify === null;
    case "GapAnalysis":
      return config.skills.gap === null;
    default:
      return false;
  }
};

const ALREADY_IMPLEMENTED_PATTERNS = [
  "already implemented",
  "tests are already",
  "code already",
  "implementation already",
  "already passing",
  "no changes needed",
  "all tests pass",
];

export const isAlreadyImplemented = (
  tddText: string,
  headSha: string,
  baseSha: string,
): boolean => {
  if (headSha !== baseSha) {
    return false;
  }
  const lower = tddText.toLowerCase();
  return ALREADY_IMPLEMENTED_PATTERNS.some((pattern) => lower.includes(pattern));
};
