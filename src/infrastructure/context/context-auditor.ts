import { statSync } from "fs";
import { join } from "path";
import type {
  RepoContextArtifact,
  RepoContextEntryProvenance,
  RepoContextLeafPath,
  RepoContextLayers,
} from "#domain/context.js";
import { mergeRepoContextLayers } from "#domain/context.js";
import { updateRepoContext } from "./context-store.js";

// ─── File verification ────────────────────────────────────────────────────

const isFileUnchangedSince = (filePath: string, isoTimestamp: string): boolean => {
  try {
    const stat = statSync(filePath);
    return stat.mtimeMs <= new Date(isoTimestamp).getTime();
  } catch {
    // File doesn't exist — it has diverged
    return false;
  }
};

type AuditableLayerName = "detected" | "planner";
type MutableLayers = {
  [K in keyof RepoContextLayers]: {
    context: RepoContextLayers[K]["context"];
    provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance>;
  };
};

const verifiedNote = "verified: supporting files unchanged";
const staleNote = "stale: supporting file changed";

const syncLayerEntry = (
  layers: MutableLayers,
  layerName: AuditableLayerName,
  leafPath: RepoContextLeafPath,
  nextEntry: RepoContextEntryProvenance,
): boolean => {
  const currentEntry = layers[layerName].provenance[leafPath];
  if (
    currentEntry?.source === nextEntry.source &&
    currentEntry.note === nextEntry.note &&
    currentEntry.updatedAt === nextEntry.updatedAt &&
    JSON.stringify(currentEntry.supportingFiles ?? []) ===
      JSON.stringify(nextEntry.supportingFiles ?? [])
  ) {
    return false;
  }

  layers[layerName].provenance[leafPath] = nextEntry;
  return true;
};

// ─── Core audit logic ─────────────────────────────────────────────────────

export const auditContextEntries = (
  artifact: RepoContextArtifact,
  cwd: string,
): RepoContextArtifact => {
  let changed = false;

  const updatedLayers: MutableLayers = {
    operator: {
      context: artifact.layers.operator.context,
      provenance: { ...artifact.layers.operator.provenance },
    },
    detected: {
      context: artifact.layers.detected.context,
      provenance: { ...artifact.layers.detected.provenance },
    },
    planner: {
      context: artifact.layers.planner.context,
      provenance: { ...artifact.layers.planner.provenance },
    },
  };

  for (const layerName of ["detected", "planner"] as const) {
    for (const [path, entry] of Object.entries(artifact.layers[layerName].provenance)) {
      const leafPath = path as RepoContextLeafPath;
      const files = entry.supportingFiles;
      if (files === undefined || files.length === 0) {
        continue;
      }

      const allFilesMatch = files.every((f) => isFileUnchangedSince(join(cwd, f), entry.updatedAt));
      if (allFilesMatch) {
        changed =
          syncLayerEntry(updatedLayers, layerName, leafPath, {
            ...entry,
            source: "verified",
            note: verifiedNote,
          }) || changed;
        continue;
      }

      changed =
        syncLayerEntry(updatedLayers, layerName, leafPath, {
          ...entry,
          source: layerName,
          note: staleNote,
        }) || changed;
    }
  }

  if (!changed) {
    return artifact;
  }

  const newLayers: RepoContextLayers = {
    operator: updatedLayers.operator,
    detected: updatedLayers.detected,
    planner: updatedLayers.planner,
  };

  return {
    ...artifact,
    layers: newLayers,
    effective: mergeRepoContextLayers(newLayers),
  };
};

// ─── Background wrapper ───────────────────────────────────────────────────

export const auditContextInBackground = async (outputDir: string, cwd: string): Promise<void> => {
  updateRepoContext(outputDir, (artifact) => auditContextEntries(artifact, cwd));
};
