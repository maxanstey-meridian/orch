export type OrchestratorState = {
  readonly lastCompletedSlice?: number;
  readonly lastCompletedGroup?: string;
  readonly lastSliceImplemented?: number;
  readonly reviewBaseSha?: string;
  readonly tddSessionId?: string;
  readonly reviewSessionId?: string;
  readonly worktree?: {
    readonly path: string;
    readonly branch: string;
    readonly baseSha: string;
  };
};

export type StateEvent =
  | { readonly kind: "sliceDone"; readonly sliceNumber: number }
  | { readonly kind: "groupDone"; readonly groupName: string }
  | { readonly kind: "agentSpawned"; readonly role: "tdd" | "review"; readonly sessionId: string }
  | {
      readonly kind: "sliceImplemented";
      readonly sliceNumber: number;
      readonly reviewBaseSha: string;
    };

export const advanceState = (state: OrchestratorState, event: StateEvent): OrchestratorState => {
  switch (event.kind) {
    case "sliceDone":
      return {
        ...state,
        lastCompletedSlice: event.sliceNumber,
        lastSliceImplemented: event.sliceNumber,
      };
    case "groupDone":
      return { ...state, lastCompletedGroup: event.groupName };
    case "agentSpawned":
      return event.role === "tdd"
        ? { ...state, tddSessionId: event.sessionId }
        : { ...state, reviewSessionId: event.sessionId };
    case "sliceImplemented":
      return {
        ...state,
        lastSliceImplemented: event.sliceNumber,
        reviewBaseSha: event.reviewBaseSha,
      };
  }
};
