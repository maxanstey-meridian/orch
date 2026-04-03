import type { Provider } from "./config.js";
import type { ExecutionMode } from "./config.js";

export type PersistedPhase = "tdd" | "review" | "verify" | "gap" | "final" | "plan";

export type PersistedAgentSession = {
  readonly provider: Provider;
  readonly id: string;
};

export type OrchestratorState = {
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly executionMode?: ExecutionMode;
  readonly currentPhase?: PersistedPhase;
  readonly currentSlice?: number;
  readonly currentGroup?: string;
  readonly sliceTimings?: ReadonlyArray<{
    readonly number: number;
    readonly startedAt: string;
    readonly completedAt?: string;
  }>;
  readonly lastCompletedSlice?: number;
  readonly lastCompletedGroup?: string;
  readonly lastSliceImplemented?: number;
  readonly reviewBaseSha?: string;
  readonly tddSession?: PersistedAgentSession;
  readonly reviewSession?: PersistedAgentSession;
  readonly worktree?: {
    readonly path: string;
    readonly branch: string;
    readonly baseSha: string;
  };
};

export type StateEvent =
  | { readonly kind: "sliceStarted"; readonly sliceNumber: number; readonly groupName: string }
  | { readonly kind: "phaseEntered"; readonly phase: PersistedPhase; readonly sliceNumber: number }
  | { readonly kind: "sliceDone"; readonly sliceNumber: number }
  | { readonly kind: "groupDone"; readonly groupName: string }
  | {
      readonly kind: "agentSpawned";
      readonly role: "tdd" | "review";
      readonly session: PersistedAgentSession;
    }
  | {
      readonly kind: "sliceImplemented";
      readonly sliceNumber: number;
      readonly reviewBaseSha: string;
    };

export const advanceState = (state: OrchestratorState, event: StateEvent): OrchestratorState => {
  switch (event.kind) {
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
      return event.role === "tdd"
        ? { ...state, tddSession: event.session }
        : { ...state, reviewSession: event.session };
    case "sliceImplemented":
      return {
        ...state,
        lastSliceImplemented: event.sliceNumber,
        reviewBaseSha: event.reviewBaseSha,
      };
  }
};
