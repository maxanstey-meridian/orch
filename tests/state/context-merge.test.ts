import { describe, it, expect } from "vitest";
import {
  createEmptyRepoContextArtifact,
  type RepoContextArtifact,
} from "#domain/context.js";
import { mergePlannerContextUpdates } from "#infrastructure/context/context-merge.js";

const baseArtifact = (overrides?: Partial<RepoContextArtifact>): RepoContextArtifact => ({
  ...createEmptyRepoContextArtifact({ rootPath: "/repo", generatedAt: "2026-01-01T00:00:00.000Z" }),
  ...overrides,
});

describe("mergePlannerContextUpdates", () => {
  it("adds new keys into the planner layer and recomputes effective", () => {
    const artifact = baseArtifact();
    const result = mergePlannerContextUpdates(artifact, {
      architecture: "Clean Architecture",
      keyFiles: { "src/main.ts": "Bootstrap" },
    });

    expect(result.layers.planner.context.architecture).toBe("Clean Architecture");
    expect(result.layers.planner.context.keyFiles?.["src/main.ts"]).toBe("Bootstrap");
    expect(result.effective.context.architecture).toBe("Clean Architecture");
    expect(result.effective.context.keyFiles?.["src/main.ts"]).toBe("Bootstrap");
  });

  it("does not overwrite operator-authored entries", () => {
    const artifact = baseArtifact({
      layers: {
        operator: {
          context: { architecture: "Operator says monolith" },
          provenance: {
            "context.architecture": {
              source: "operator",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        detected: { context: {}, provenance: {} },
        planner: { context: {}, provenance: {} },
      },
      effective: {
        context: { architecture: "Operator says monolith" },
        provenance: {
          "context.architecture": {
            source: "operator",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    const result = mergePlannerContextUpdates(artifact, {
      architecture: "Planner says microservices",
    });

    // Operator wins — planner layer should NOT have this entry
    expect(result.layers.planner.context.architecture).toBeUndefined();
    // Effective still shows operator value
    expect(result.effective.context.architecture).toBe("Operator says monolith");
  });

  it("does not overwrite verified entries", () => {
    const artifact = baseArtifact({
      layers: {
        operator: { context: {}, provenance: {} },
        detected: {
          context: { architecture: "Detected arch" },
          provenance: {
            "context.architecture": {
              source: "verified",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        planner: { context: {}, provenance: {} },
      },
      effective: {
        context: { architecture: "Detected arch" },
        provenance: {
          "context.architecture": {
            source: "verified",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    const result = mergePlannerContextUpdates(artifact, {
      architecture: "Planner override attempt",
    });

    // Verified wins — planner entry skipped
    expect(result.layers.planner.context.architecture).toBeUndefined();
    expect(result.effective.context.architecture).toBe("Detected arch");
    expect(result.effective.provenance["context.architecture"]?.source).toBe("verified");
  });

  it("planner can add keys alongside existing detected entries", () => {
    const artifact = baseArtifact({
      layers: {
        operator: { context: {}, provenance: {} },
        detected: {
          context: { architecture: "Detected arch" },
          provenance: {
            "context.architecture": {
              source: "detected",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        planner: { context: {}, provenance: {} },
      },
      effective: {
        context: { architecture: "Detected arch" },
        provenance: {
          "context.architecture": {
            source: "detected",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    const result = mergePlannerContextUpdates(artifact, {
      concepts: { newConcept: "Discovered during planning" },
    });

    expect(result.layers.planner.context.concepts?.newConcept).toBe("Discovered during planning");
    expect(result.effective.context.concepts?.newConcept).toBe("Discovered during planning");
    // Detected architecture still present in effective
    expect(result.effective.context.architecture).toBe("Detected arch");
  });

  it("bootstraps empty repo with planner context", () => {
    const artifact = baseArtifact();
    const result = mergePlannerContextUpdates(artifact, {
      architecture: "Fresh project architecture",
      keyFiles: { "src/index.ts": "Entry point" },
      concepts: { core: "Main business logic" },
      conventions: { testing: "Vitest with fakes" },
    });

    expect(result.effective.context.architecture).toBe("Fresh project architecture");
    expect(result.effective.context.keyFiles?.["src/index.ts"]).toBe("Entry point");
    expect(result.effective.context.concepts?.core).toBe("Main business logic");
    expect(result.effective.context.conventions?.testing).toBe("Vitest with fakes");
  });

  it("returns unchanged artifact when updates are empty", () => {
    const artifact = baseArtifact({
      layers: {
        operator: { context: {}, provenance: {} },
        detected: {
          context: { architecture: "Existing" },
          provenance: {},
        },
        planner: { context: {}, provenance: {} },
      },
      effective: {
        context: { architecture: "Existing" },
        provenance: {},
      },
    });

    const result = mergePlannerContextUpdates(artifact, {});

    expect(result).toBe(artifact);
  });

  it("planner updates carry provenance with source planner", () => {
    const artifact = baseArtifact();
    const result = mergePlannerContextUpdates(artifact, {
      architecture: "New arch",
    });

    const prov = result.layers.planner.provenance["context.architecture"];
    expect(prov).toBeDefined();
    expect(prov?.source).toBe("planner");
    expect(prov?.updatedAt).toBeDefined();
  });

  it("preserves existing planner entries not covered by updates", () => {
    const artifact = baseArtifact({
      layers: {
        operator: { context: {}, provenance: {} },
        detected: { context: {}, provenance: {} },
        planner: {
          context: { concepts: { existingConcept: "Already known" } },
          provenance: {
            "context.concepts.existingConcept": {
              source: "planner",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      },
      effective: {
        context: { concepts: { existingConcept: "Already known" } },
        provenance: {
          "context.concepts.existingConcept": {
            source: "planner",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    const result = mergePlannerContextUpdates(artifact, {
      architecture: "New arch from planner",
    });

    expect(result.layers.planner.context.concepts?.existingConcept).toBe("Already known");
    expect(result.layers.planner.context.architecture).toBe("New arch from planner");
    expect(result.effective.context.concepts?.existingConcept).toBe("Already known");
    expect(result.effective.context.architecture).toBe("New arch from planner");
  });
});
