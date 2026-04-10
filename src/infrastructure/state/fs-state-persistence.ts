import { StatePersistence } from "#application/ports/state-persistence.port.js";
import type { OrchestratorState } from "#domain/state.js";
import { clearState, loadState, saveState } from "./state.js";

export class FsStatePersistence extends StatePersistence {
  constructor(private readonly filePath: string) {
    super();
  }

  async load(): Promise<OrchestratorState> {
    return loadState(this.filePath);
  }

  async save(state: OrchestratorState): Promise<void> {
    await saveState(this.filePath, state);
  }

  async clear(): Promise<void> {
    await clearState(this.filePath);
  }
}
