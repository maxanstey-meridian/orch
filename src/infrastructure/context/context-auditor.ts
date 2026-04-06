import { statSync } from "fs";
import { join } from "path";
import type {
  RepoContextArtifact,
  RepoContextEntryProvenance,
  RepoContextLeafPath,
  RepoContextLayers,
} from "#domain/context.js";
import { mergeRepoContextLayers } from "#domain/context.js";
import { tryLoadRepoContext, saveRepoContext } from "./context-store.js";

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

// ─── Core audit logic ─────────────────────────────────────────────────────

export const auditContextEntries = (
  artifact: RepoContextArtifact,
  cwd: string,
): RepoContextArtifact => {
  let changed = false;

  // Build mutable copies of layer provenance
  const updatedLayers: {
    [K in keyof RepoContextLayers]: {
      context: RepoContextLayers[K]["context"];
      provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance>;
    };
  } = {
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

  for (const [path, entry] of Object.entries(artifact.effective.provenance)) {
    const leafPath = path as RepoContextLeafPath;

    // Skip operator entries — they're authoritative
    if (entry.source === "operator") {
      continue;
    }

    // Skip entries without supporting files — nothing to verify
    const files = entry.supportingFiles;
    if (files === undefined || files.length === 0) {
      continue;
    }

    // Skip already-verified entries
    if (entry.source === "verified") {
      continue;
    }

    const allFilesMatch = files.every((f) => isFileUnchangedSince(join(cwd, f), entry.updatedAt));
    const sourceLayer = entry.source as "detected" | "planner";

    if (allFilesMatch) {
      // Promote to verified
      changed = true;
      updatedLayers[sourceLayer].provenance[leafPath] = {
        ...entry,
        source: "verified",
        note: "verified: supporting files unchanged",
      };
    } else {
      // Mark stale — only if not already stale
      if (!entry.note?.startsWith("stale:")) {
        changed = true;
        updatedLayers[sourceLayer].provenance[leafPath] = {
          ...entry,
          note: "stale: supporting file changed",
        };
      }
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

export const auditContextInBackground = (outputDir: string, cwd: string): void => {
  const run = async (): Promise<void> => {
    const artifact = tryLoadRepoContext(outputDir);
    if (artifact === null) {
      return;
    }

    const audited = auditContextEntries(artifact, cwd);
    if (audited !== artifact) {
      saveRepoContext(outputDir, audited);
    }
  };

  run().catch(() => {
    // Audit errors are contained — never fail foreground work
  });
};
