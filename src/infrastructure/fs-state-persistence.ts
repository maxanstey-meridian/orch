import { StatePersistence } from "../application/ports/state-persistence.port.js";
import type { OrchestratorState } from "../domain/state.js";
import { loadState, saveState, clearState } from "./state/state.js";

export class FsStatePersistence implements StatePersistence {
  constructor(private readonly filePath: string) {}

  async load(): Promise<OrchestratorState> {
    return loadState(this.filePath);
  }

  async save(state: OrchestratorState): Promise<void> {
    return saveState(this.filePath, state);
  }

  async clear(): Promise<void> {
    return clearState(this.filePath);
  }
}
