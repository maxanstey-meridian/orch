import { StatePersistence } from "#application/ports/state-persistence.port.js";
import type { OrchestratorState } from "#domain/state.js";

export class InMemoryStatePersistence extends StatePersistence {
  current: OrchestratorState = {};
  readonly saveHistory: OrchestratorState[] = [];

  async load(): Promise<OrchestratorState> {
    return { ...this.current };
  }

  async save(state: OrchestratorState): Promise<void> {
    this.current = { ...state };
    this.saveHistory.push({ ...state });
  }

  async clear(): Promise<void> {
    this.current = {};
  }
}
