import type { OrchestratorState } from "../../domain/state.js";

export abstract class StatePersistence {
  abstract load(): Promise<OrchestratorState>;
  abstract save(state: OrchestratorState): Promise<void>;
  abstract clear(): Promise<void>;
}
