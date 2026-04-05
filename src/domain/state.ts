import type { Provider, ExecutionMode } from "./config.js";
import type { ComplexityTier } from "./triage.js";

export type PersistedPhase =
  | "tdd"
  | "review"
  | "verify"
  | "completeness"
  | "gap"
  | "final"
  | "plan";

export type PersistedAgentSession = {
  readonly provider: Provider;
  readonly id: string;
};

export type OrchestratorState = {
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly executionMode?: ExecutionMode;
  readonly tier?: ComplexityTier;
  readonly activeTier?: ComplexityTier;
  readonly currentPhase?: PersistedPhase;
  readonly currentSlice?: number;
  readonly currentGroup?: string;
  readonly currentGroupBaseSha?: string;
  readonly sliceTimings?: ReadonlyArray<{
    readonly number: number;
    readonly startedAt: string;
    readonly completedAt?: string;
  }>;
  readonly lastCompletedSlice?: number;
  readonly lastCompletedGroup?: string;
  readonly lastSliceImplemented?: number;
  readonly reviewBaseSha?: string;
  readonly pendingVerifyBaseSha?: string;
  readonly pendingCompletenessBaseSha?: string;
  readonly pendingReviewBaseSha?: string;
  readonly pendingGapBaseSha?: string;
  readonly tddSession?: PersistedAgentSession;
  readonly reviewSession?: PersistedAgentSession;
  readonly verifySession?: PersistedAgentSession;
  readonly gapSession?: PersistedAgentSession;
  readonly worktree?: {
    readonly path: string;
    readonly branch: string;
    readonly baseSha: string;
    readonly managed: boolean;
  };
};

export type StateEvent =
  | { readonly kind: "groupStarted"; readonly groupName: string; readonly sliceNumber: number }
  | { readonly kind: "sliceStarted"; readonly sliceNumber: number; readonly groupName: string }
  | { readonly kind: "phaseEntered"; readonly phase: PersistedPhase; readonly sliceNumber: number }
  | { readonly kind: "sliceDone"; readonly sliceNumber: number }
  | { readonly kind: "groupDone"; readonly groupName: string }
  | {
      readonly kind: "agentSpawned";
      readonly role: "tdd" | "review" | "verify" | "gap";
      readonly session: PersistedAgentSession;
    }
  | { readonly kind: "groupAgentsCleared" }
  | {
      readonly kind: "sliceImplemented";
      readonly sliceNumber: number;
      readonly reviewBaseSha: string;
      readonly pendingVerifyBaseSha?: string;
      readonly pendingCompletenessBaseSha?: string;
      readonly pendingGapBaseSha?: string;
    }
  | {
      readonly kind: "policyUpdated";
      readonly activeTier: ComplexityTier;
      readonly currentGroupBaseSha?: string;
      readonly pendingVerifyBaseSha?: string;
      readonly pendingCompletenessBaseSha?: string;
      readonly pendingReviewBaseSha?: string;
      readonly pendingGapBaseSha?: string;
    };

export const advanceState = (state: OrchestratorState, event: StateEvent): OrchestratorState => {
  switch (event.kind) {
    case "groupStarted": {
      const startedAt = state.startedAt ?? new Date().toISOString();
      return {
        ...state,
        startedAt,
        currentGroup: event.groupName,
        currentSlice: event.sliceNumber,
      };
    }
    case "sliceStarted": {
      const eventStartedAt = new Date().toISOString();
      const startedAt = state.startedAt ?? eventStartedAt;
      const sliceTimings = state.sliceTimings ?? [];
      const hasTiming = sliceTimings.some((timing) => timing.number === event.sliceNumber);
      return {
        ...state,
        startedAt,
        currentSlice: event.sliceNumber,
        currentGroup: event.groupName,
        sliceTimings: hasTiming
          ? sliceTimings
          : [...sliceTimings, { number: event.sliceNumber, startedAt: eventStartedAt }],
      };
    }
    case "phaseEntered":
      return { ...state, currentPhase: event.phase };
    case "sliceDone": {
      const completedAt = new Date().toISOString();
      return {
        ...state,
        currentPhase: undefined,
        lastCompletedSlice: event.sliceNumber,
        lastSliceImplemented: event.sliceNumber,
        sliceTimings: state.sliceTimings?.map((timing) =>
          timing.number === event.sliceNumber && timing.completedAt === undefined
            ? { ...timing, completedAt }
            : timing,
        ),
      };
    }
    case "groupDone":
      return { ...state, currentPhase: undefined, lastCompletedGroup: event.groupName };
    case "agentSpawned":
      switch (event.role) {
        case "tdd":
          return { ...state, tddSession: event.session };
        case "review":
          return { ...state, reviewSession: event.session };
        case "verify":
          return { ...state, verifySession: event.session };
        case "gap":
          return { ...state, gapSession: event.session };
      }
    case "groupAgentsCleared":
      return {
        ...state,
        verifySession: undefined,
        gapSession: undefined,
      };
    case "sliceImplemented":
      return {
        ...state,
        lastSliceImplemented: event.sliceNumber,
        reviewBaseSha: event.reviewBaseSha,
        pendingVerifyBaseSha: event.pendingVerifyBaseSha ?? state.pendingVerifyBaseSha,
        pendingCompletenessBaseSha:
          event.pendingCompletenessBaseSha ?? state.pendingCompletenessBaseSha,
        pendingGapBaseSha: event.pendingGapBaseSha ?? state.pendingGapBaseSha,
      };
    case "policyUpdated":
      return {
        ...state,
        tier: event.activeTier,
        activeTier: event.activeTier,
        currentGroupBaseSha: event.currentGroupBaseSha,
        pendingVerifyBaseSha: event.pendingVerifyBaseSha,
        pendingCompletenessBaseSha: event.pendingCompletenessBaseSha,
        pendingReviewBaseSha: event.pendingReviewBaseSha,
        pendingGapBaseSha: event.pendingGapBaseSha,
      };
  }
};
