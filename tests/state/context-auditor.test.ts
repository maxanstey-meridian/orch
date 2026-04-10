import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createEmptyRepoContextArtifact,
  mergeRepoContextLayers,
  type RepoContextArtifact,
  type RepoContextEntryProvenance,
  type RepoContextLeafPath,
  type RepoContextLayers,
} from "#domain/context.js";
import {
  auditContextEntries,
  auditContextInBackground,
} from "#infrastructure/context/context-auditor.js";
import {
  saveRepoContext,
  loadRepoContext,
} from "#infrastructure/context/context-store.js";

let tempDir: string;
let orchDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-auditor-test-"));
  orchDir = join(tempDir, ".orch");
  await mkdir(orchDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

const pastTimestamp = "2026-01-01T00:00:00.000Z";

const makeArtifact = (overrides?: {
  layers?: Partial<RepoContextLayers>;
}): RepoContextArtifact => {
  const base = createEmptyRepoContextArtifact({
    rootPath: tempDir,
    generatedAt: pastTimestamp,
  });

  const layers: RepoContextLayers = {
    operator: overrides?.layers?.operator ?? base.layers.operator,
    detected: overrides?.layers?.detected ?? base.layers.detected,
    planner: overrides?.layers?.planner ?? base.layers.planner,
  };

  return {
    ...base,
    layers,
    effective: mergeRepoContextLayers(layers),
  };
};

// ─── auditContextEntries (pure) ───────────────────────────────────────────

describe("auditContextEntries", () => {
  it("promotes a planner entry to verified when supporting file is unchanged", async () => {
    // Create file BEFORE the provenance timestamp
    const filePath = join(tempDir, "src", "main.ts");
    await mkdir(join(tempDir, "src"), { recursive: true });
    writeFileSync(filePath, "console.log('hello')");
    // Set mtime to well before the provenance timestamp
    const oldTime = new Date("2025-06-01T00:00:00.000Z");
    utimesSync(filePath, oldTime, oldTime);

    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.keyFiles.src/main.ts": {
        source: "planner",
        updatedAt: "2026-01-01T00:00:00.000Z",
        supportingFiles: ["src/main.ts"],
      },
    };

    const artifact = makeArtifact({
      layers: {
        planner: {
          context: { keyFiles: { "src/main.ts": "Entry point" } },
          provenance,
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    // Should have promoted to verified on the planner layer
    const plannerProv = result.layers.planner.provenance["context.keyFiles.src/main.ts"];
    expect(plannerProv).toBeDefined();
    expect(plannerProv!.source).toBe("verified");
    expect(plannerProv!.note).toBe("verified: supporting files unchanged");

    // Effective should also reflect verified
    const effectiveProv = result.effective.provenance["context.keyFiles.src/main.ts"];
    expect(effectiveProv).toBeDefined();
    expect(effectiveProv!.source).toBe("verified");
  });

  it("marks a planner entry stale when supporting file has been modified", async () => {
    // Create file AFTER the provenance timestamp
    const filePath = join(tempDir, "src", "main.ts");
    await mkdir(join(tempDir, "src"), { recursive: true });
    writeFileSync(filePath, "modified content");
    // mtime is now (2026-04-06) which is after the 2025-06-01 provenance

    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.keyFiles.src/main.ts": {
        source: "planner",
        updatedAt: "2025-06-01T00:00:00.000Z",
        supportingFiles: ["src/main.ts"],
      },
    };

    const artifact = makeArtifact({
      layers: {
        planner: {
          context: { keyFiles: { "src/main.ts": "Entry point" } },
          provenance,
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    const plannerProv = result.layers.planner.provenance["context.keyFiles.src/main.ts"];
    expect(plannerProv).toBeDefined();
    expect(plannerProv!.source).toBe("planner"); // source unchanged
    expect(plannerProv!.note).toBe("stale: supporting file changed");
  });

  it("marks a detector entry stale when supporting file does not exist", () => {
    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.keyFiles.src/gone.ts": {
        source: "detected",
        updatedAt: pastTimestamp,
        supportingFiles: ["src/gone.ts"],
      },
    };

    const artifact = makeArtifact({
      layers: {
        detected: {
          context: { keyFiles: { "src/gone.ts": "Was here" } },
          provenance,
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    const detectedProv = result.layers.detected.provenance["context.keyFiles.src/gone.ts"];
    expect(detectedProv).toBeDefined();
    expect(detectedProv!.note).toBe("stale: supporting file changed");
  });

  it("preserves operator entries without modification", async () => {
    const filePath = join(tempDir, "CLAUDE.md");
    writeFileSync(filePath, "# rules");

    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.architecture": {
        source: "operator",
        updatedAt: pastTimestamp,
        supportingFiles: ["CLAUDE.md"],
      },
    };

    const artifact = makeArtifact({
      layers: {
        operator: {
          context: { architecture: "Clean Architecture" },
          provenance,
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    // Operator entries should be untouched
    expect(result.layers.operator.provenance["context.architecture"]).toEqual(
      provenance["context.architecture"],
    );
    // Should return the same object reference (no changes)
    expect(result).toBe(artifact);
  });

  it("preserves entries without supportingFiles", () => {
    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.architecture": {
        source: "planner",
        updatedAt: pastTimestamp,
        // No supportingFiles
      },
    };

    const artifact = makeArtifact({
      layers: {
        planner: {
          context: { architecture: "Microservices" },
          provenance,
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    // No changes — same reference
    expect(result).toBe(artifact);
  });

  it("marks a verified planner entry stale when supporting files diverge later", async () => {
    const filePath = join(tempDir, "src", "main.ts");
    await mkdir(join(tempDir, "src"), { recursive: true });
    writeFileSync(filePath, "content");

    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.keyFiles.src/main.ts": {
        source: "verified",
        updatedAt: pastTimestamp,
        supportingFiles: ["src/main.ts"],
        note: "verified: supporting files unchanged",
      },
    };

    const artifact = makeArtifact({
      layers: {
        planner: {
          context: { keyFiles: { "src/main.ts": "Entry point" } },
          provenance,
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    const plannerProv = result.layers.planner.provenance["context.keyFiles.src/main.ts"];
    expect(plannerProv).toBeDefined();
    expect(plannerProv!.source).toBe("planner");
    expect(plannerProv!.note).toBe("stale: supporting file changed");
  });

  it("audits shadowed detected entries even when planner wins effective precedence", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });

    const plannerPath = join(tempDir, "src", "main.ts");
    writeFileSync(plannerPath, "planner");
    const oldTime = new Date("2025-06-01T00:00:00.000Z");
    utimesSync(plannerPath, oldTime, oldTime);

    const artifact = makeArtifact({
      layers: {
        planner: {
          context: { architecture: "Planner architecture" },
          provenance: {
            "context.architecture": {
              source: "planner",
              updatedAt: pastTimestamp,
              supportingFiles: ["src/main.ts"],
            },
          },
        },
        detected: {
          context: { architecture: "Detected architecture" },
          provenance: {
            "context.architecture": {
              source: "detected",
              updatedAt: pastTimestamp,
              supportingFiles: ["src/missing.ts"],
            },
          },
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    expect(result.layers.planner.provenance["context.architecture"]!.source).toBe("verified");
    expect(result.layers.detected.provenance["context.architecture"]!.source).toBe("detected");
    expect(result.layers.detected.provenance["context.architecture"]!.note).toBe(
      "stale: supporting file changed",
    );
  });

  it("handles mixed entries: promotes valid, stales invalid, preserves unrelated", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });

    // Valid file — unchanged
    const validPath = join(tempDir, "src", "valid.ts");
    writeFileSync(validPath, "valid");
    const oldTime = new Date("2025-06-01T00:00:00.000Z");
    utimesSync(validPath, oldTime, oldTime);

    // No supporting files entry — should be preserved as-is

    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.keyFiles.src/valid.ts": {
        source: "planner",
        updatedAt: pastTimestamp,
        supportingFiles: ["src/valid.ts"],
      },
      "context.keyFiles.src/missing.ts": {
        source: "detected",
        updatedAt: pastTimestamp,
        supportingFiles: ["src/missing.ts"],
      },
      "context.architecture": {
        source: "planner",
        updatedAt: pastTimestamp,
        // No supportingFiles
      },
    };

    const artifact = makeArtifact({
      layers: {
        planner: {
          context: {
            architecture: "Clean",
            keyFiles: { "src/valid.ts": "Valid file" },
          },
          provenance: {
            "context.keyFiles.src/valid.ts": provenance["context.keyFiles.src/valid.ts"],
            "context.architecture": provenance["context.architecture"],
          },
        },
        detected: {
          context: { keyFiles: { "src/missing.ts": "Missing file" } },
          provenance: {
            "context.keyFiles.src/missing.ts": provenance["context.keyFiles.src/missing.ts"],
          },
        },
      },
    });

    const result = auditContextEntries(artifact, tempDir);

    // Valid entry promoted
    expect(result.layers.planner.provenance["context.keyFiles.src/valid.ts"]!.source).toBe(
      "verified",
    );

    // Missing entry staled
    expect(result.layers.detected.provenance["context.keyFiles.src/missing.ts"]!.note).toBe(
      "stale: supporting file changed",
    );

    // Architecture entry (no files) — unchanged
    expect(result.layers.planner.provenance["context.architecture"]).toEqual(
      provenance["context.architecture"],
    );
  });
});

// ─── auditContextInBackground (integration) ──────────────────────────────

describe("auditContextInBackground", () => {
  it("persists audited artifact to disk", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    const filePath = join(tempDir, "src", "main.ts");
    writeFileSync(filePath, "content");
    const oldTime = new Date("2025-06-01T00:00:00.000Z");
    utimesSync(filePath, oldTime, oldTime);

    const provenance: Record<RepoContextLeafPath, RepoContextEntryProvenance> = {
      "context.keyFiles.src/main.ts": {
        source: "planner",
        updatedAt: pastTimestamp,
        supportingFiles: ["src/main.ts"],
      },
    };

    const artifact = makeArtifact({
      layers: {
        planner: {
          context: { keyFiles: { "src/main.ts": "Entry" } },
          provenance,
        },
      },
    });

    saveRepoContext(orchDir, artifact);

    await auditContextInBackground(orchDir, tempDir);

    const reloaded = loadRepoContext(orchDir);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.layers.planner.provenance["context.keyFiles.src/main.ts"]!.source).toBe(
      "verified",
    );
  });

  it("returns cleanly when context.json does not exist", async () => {
    await expect(auditContextInBackground(orchDir, tempDir)).resolves.toBeUndefined();
  });

  it("rejects when the stored artifact is invalid", async () => {
    // Write invalid JSON to context.json
    writeFileSync(join(orchDir, "context.json"), "not json");

    await expect(auditContextInBackground(orchDir, tempDir)).rejects.toThrow();
  });
});
