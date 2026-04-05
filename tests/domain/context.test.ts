import { describe, it, expect } from "vitest";
import {
  createEmptyRepoContextLayer,
  mergeRepoContextLayers,
  type RepoContextLayer,
  type RepoContextLayers,
} from "#domain/context.js";

describe("mergeRepoContextLayers", () => {
  it("operator layer wins over planner and detected for the same leaf path", () => {
    const operator: RepoContextLayer = {
      context: { architecture: "operator-arch" },
      provenance: {
        "context.architecture": { source: "operator", updatedAt: "2026-01-01T00:00:00Z" },
      },
    };
    const planner: RepoContextLayer = {
      context: { architecture: "planner-arch" },
      provenance: {
        "context.architecture": { source: "planner", updatedAt: "2026-01-01T00:00:00Z" },
      },
    };
    const detected: RepoContextLayer = {
      context: { architecture: "detected-arch" },
      provenance: {
        "context.architecture": { source: "detected", updatedAt: "2026-01-01T00:00:00Z" },
      },
    };

    const layers: RepoContextLayers = { operator, planner, detected };
    const result = mergeRepoContextLayers(layers);

    expect(result.context.architecture).toBe("operator-arch");
    expect(result.provenance["context.architecture"]?.source).toBe("operator");
  });

  it("planner layer wins over detected when operator has no entry", () => {
    const planner: RepoContextLayer = {
      context: { architecture: "planner-arch" },
      provenance: {
        "context.architecture": { source: "planner", updatedAt: "2026-01-01T00:00:00Z" },
      },
    };
    const detected: RepoContextLayer = {
      context: { architecture: "detected-arch" },
      provenance: {
        "context.architecture": { source: "detected", updatedAt: "2026-01-01T00:00:00Z" },
      },
    };

    const layers: RepoContextLayers = {
      operator: createEmptyRepoContextLayer(),
      planner,
      detected,
    };
    const result = mergeRepoContextLayers(layers);

    expect(result.context.architecture).toBe("planner-arch");
    expect(result.provenance["context.architecture"]?.source).toBe("planner");
  });

  it("merges non-overlapping keys from all layers", () => {
    const operator: RepoContextLayer = {
      context: { concepts: { language: "TypeScript" } },
      provenance: {
        "context.concepts.language": { source: "operator", updatedAt: "2026-01-01T00:00:00Z" },
      },
    };
    const detected: RepoContextLayer = {
      context: { architecture: "Clean Architecture" },
      provenance: {
        "context.architecture": { source: "detected", updatedAt: "2026-01-01T00:00:00Z" },
      },
    };

    const layers: RepoContextLayers = {
      operator,
      planner: createEmptyRepoContextLayer(),
      detected,
    };
    const result = mergeRepoContextLayers(layers);

    expect(result.context.architecture).toBe("Clean Architecture");
    expect(result.context.concepts?.language).toBe("TypeScript");
  });
});
