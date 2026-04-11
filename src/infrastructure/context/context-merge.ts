import type {
  RepoContextArtifact,
  RepoContextData,
  RepoContextEntryProvenance,
  RepoContextLeafPath,
} from "#domain/context.js";
import {
  flattenRepoContextData,
  mergeRepoContextLayers,
  unflattenRepoContextData,
} from "#domain/context.js";
import type { PlanContext } from "#domain/plan.js";

const planContextToRepoContextData = (updates: PlanContext): RepoContextData => ({
  ...(updates.architecture !== undefined ? { architecture: updates.architecture } : {}),
  ...(updates.keyFiles !== undefined ? { keyFiles: updates.keyFiles } : {}),
  ...(updates.concepts !== undefined ? { concepts: updates.concepts } : {}),
  ...(updates.conventions !== undefined ? { conventions: updates.conventions } : {}),
});

export const mergePlannerContextUpdates = (
  artifact: RepoContextArtifact,
  updates: PlanContext,
): RepoContextArtifact => {
  const updateData = planContextToRepoContextData(updates);
  const flatUpdates = flattenRepoContextData(updateData);

  if (Object.keys(flatUpdates).length === 0) {
    return artifact;
  }

  const operatorFlat = flattenRepoContextData(artifact.layers.operator.context);
  const now = new Date().toISOString();

  const newPlannerEntries = new Map<RepoContextLeafPath, string>();
  const newPlannerProvenance = new Map<RepoContextLeafPath, RepoContextEntryProvenance>();

  // Copy existing planner entries
  const existingPlannerFlat = flattenRepoContextData(artifact.layers.planner.context);
  for (const [path, value] of Object.entries(existingPlannerFlat) as Array<
    [RepoContextLeafPath, string]
  >) {
    newPlannerEntries.set(path, value);
    const prov = artifact.layers.planner.provenance[path];
    if (prov !== undefined) {
      newPlannerProvenance.set(path, prov);
    }
  }

  for (const [path, value] of Object.entries(flatUpdates) as Array<[RepoContextLeafPath, string]>) {
    // Operator layer wins — skip if operator already has this path
    if (path in operatorFlat) {
      continue;
    }

    // Verified entries win — skip if effective provenance says verified
    const effectiveProv = artifact.effective.provenance[path];
    if (effectiveProv?.source === "verified") {
      continue;
    }

    newPlannerEntries.set(path, value);
    newPlannerProvenance.set(path, {
      source: "planner",
      updatedAt: now,
    });
  }

  const updatedPlannerLayer = {
    context: unflattenRepoContextData(Object.fromEntries(newPlannerEntries)),
    provenance: Object.fromEntries(newPlannerProvenance),
  };

  const updatedLayers = {
    operator: artifact.layers.operator,
    detected: artifact.layers.detected,
    planner: updatedPlannerLayer,
  };

  return {
    ...artifact,
    layers: updatedLayers,
    effective: mergeRepoContextLayers(updatedLayers),
  };
};
