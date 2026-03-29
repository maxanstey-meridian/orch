import { describe, it, expect } from "vitest";
import { StatePersistence } from "../../../src/application/ports/state-persistence.port.js";
import type { OrchestratorState } from "../../../src/domain/state.js";

class InMemoryStatePersistence extends StatePersistence {
  private state: OrchestratorState | null = null;

  async load(): Promise<OrchestratorState> {
    return this.state ?? {};
  }
  async save(state: OrchestratorState): Promise<void> {
    this.state = state;
  }
  async clear(): Promise<void> {
    this.state = null;
  }
}

describe("StatePersistence", () => {
  it("InMemoryStatePersistence can be instantiated", () => {
    const persistence = new InMemoryStatePersistence();
    expect(persistence).toBeInstanceOf(StatePersistence);
  });

  it("load returns empty state when nothing saved", async () => {
    const persistence = new InMemoryStatePersistence();
    const state = await persistence.load();
    expect(state).toEqual({});
  });

  it("save then load roundtrip preserves all fields", async () => {
    const persistence = new InMemoryStatePersistence();
    const state: OrchestratorState = {
      lastCompletedSlice: 3,
      lastCompletedGroup: "Domain",
      lastSliceImplemented: 2,
      reviewBaseSha: "abc123",
      tddSessionId: "tdd-1",
      reviewSessionId: "rev-1",
      worktree: { path: "/tmp/wt", branch: "feat", baseSha: "def456" },
    };
    await persistence.save(state);
    const loaded = await persistence.load();
    expect(loaded).toEqual(state);
  });

  it("clear then load returns empty state", async () => {
    const persistence = new InMemoryStatePersistence();
    await persistence.save({ lastCompletedSlice: 1 });
    await persistence.clear();
    const loaded = await persistence.load();
    expect(loaded).toEqual({});
  });

  it("save overwrites previous state completely", async () => {
    const persistence = new InMemoryStatePersistence();
    await persistence.save({
      lastCompletedSlice: 1,
      lastCompletedGroup: "Domain",
      tddSessionId: "old",
    });
    const second: OrchestratorState = { lastCompletedSlice: 5 };
    await persistence.save(second);
    const loaded = await persistence.load();
    expect(loaded).toEqual({ lastCompletedSlice: 5 });
    expect((loaded as Record<string, unknown>).lastCompletedGroup).toBeUndefined();
    expect((loaded as Record<string, unknown>).tddSessionId).toBeUndefined();
  });
});
