import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import {
  createEmptyRepoContextArtifact,
  createEmptyRepoContextLayer,
  mergeRepoContextLayers,
  type RepoContextArtifact,
  type RepoContextLayer,
  type RepoContextLeafPath,
} from "#domain/context.js";
import {
  computeFreshnessSignature,
  isContextFresh,
  markStaleProvenanceEntries,
} from "#infrastructure/context/context-freshness.js";

const initGitRepo = (dir: string): void => {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
};

const gitCommit = (dir: string, message: string): void => {
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync(`git commit --allow-empty -m "${message}"`, { cwd: dir, stdio: "ignore" });
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-fresh-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

// ─── computeFreshnessSignature ─────────────────────────────────────────────

describe("computeFreshnessSignature", () => {
  it("returns head and manifestHash for a git repo", async () => {
    await writeFile(join(tempDir, "package.json"), "{}");
    initGitRepo(tempDir);

    const sig = computeFreshnessSignature(tempDir);

    expect(sig).toBeDefined();
    expect(sig!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(sig!.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns undefined for a non-git directory", () => {
    const sig = computeFreshnessSignature(tempDir);
    expect(sig).toBeUndefined();
  });

  it("changes manifestHash when package.json is modified", async () => {
    await writeFile(join(tempDir, "package.json"), "{}");
    initGitRepo(tempDir);

    const first = computeFreshnessSignature(tempDir);

    await writeFile(join(tempDir, "package.json"), '{"name":"changed"}');

    const second = computeFreshnessSignature(tempDir);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.head).toBe(second!.head);
    expect(first!.manifestHash).not.toBe(second!.manifestHash);
  });

  it("changes head when a new commit is made", async () => {
    initGitRepo(tempDir);

    const first = computeFreshnessSignature(tempDir);

    gitCommit(tempDir, "second");

    const second = computeFreshnessSignature(tempDir);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.head).not.toBe(second!.head);
  });

  it("includes tsconfig.json in manifest hash", async () => {
    initGitRepo(tempDir);

    const before = computeFreshnessSignature(tempDir);

    await writeFile(join(tempDir, "tsconfig.json"), '{"compilerOptions":{}}');

    const after = computeFreshnessSignature(tempDir);

    expect(before!.manifestHash).not.toBe(after!.manifestHash);
  });
});

// ─── isContextFresh ────────────────────────────────────────────────────────

describe("isContextFresh", () => {
  it("returns true when signature matches current repo state", async () => {
    await writeFile(join(tempDir, "package.json"), "{}");
    initGitRepo(tempDir);

    const sig = computeFreshnessSignature(tempDir)!;
    const artifact: RepoContextArtifact = {
      ...createEmptyRepoContextArtifact({ rootPath: tempDir }),
      freshness: sig,
    };

    expect(isContextFresh(artifact, tempDir)).toBe(true);
  });

  it("returns false when freshness is undefined", () => {
    initGitRepo(tempDir);

    const artifact = createEmptyRepoContextArtifact({ rootPath: tempDir });
    expect(isContextFresh(artifact, tempDir)).toBe(false);
  });

  it("returns false when head differs", async () => {
    initGitRepo(tempDir);

    const sig = computeFreshnessSignature(tempDir)!;
    const artifact: RepoContextArtifact = {
      ...createEmptyRepoContextArtifact({ rootPath: tempDir }),
      freshness: { ...sig, head: "0000000000000000000000000000000000000000" },
    };

    expect(isContextFresh(artifact, tempDir)).toBe(false);
  });

  it("returns false when manifestHash differs", async () => {
    initGitRepo(tempDir);

    const sig = computeFreshnessSignature(tempDir)!;
    const artifact: RepoContextArtifact = {
      ...createEmptyRepoContextArtifact({ rootPath: tempDir }),
      freshness: { ...sig, manifestHash: "stale-hash" },
    };

    expect(isContextFresh(artifact, tempDir)).toBe(false);
  });

  it("returns false in a non-git directory", () => {
    const artifact: RepoContextArtifact = {
      ...createEmptyRepoContextArtifact({ rootPath: tempDir }),
      freshness: { head: "abc", manifestHash: "def" },
    };

    expect(isContextFresh(artifact, tempDir)).toBe(false);
  });
});

// ─── markStaleProvenanceEntries ────────────────────────────────────────────

describe("markStaleProvenanceEntries", () => {
  const makeArtifactWithProvenance = (
    provenance: Record<string, { source: "detected"; updatedAt: string; supportingFiles: string[] }>,
    rootPath: string,
  ): RepoContextArtifact => {
    const detectedLayer: RepoContextLayer = {
      context: { architecture: "Test" },
      provenance: provenance as Record<RepoContextLeafPath, typeof provenance[string]>,
    };
    const layers = {
      operator: createEmptyRepoContextLayer(),
      detected: detectedLayer,
      planner: createEmptyRepoContextLayer(),
    };
    return {
      ...createEmptyRepoContextArtifact({ rootPath }),
      layers,
      effective: {
        context: mergeRepoContextLayers(layers).context,
        provenance: provenance as Record<RepoContextLeafPath, typeof provenance[string]>,
      },
    };
  };

  it("marks entries stale when supporting file has changed", async () => {
    // Create a file with a known timestamp
    await writeFile(join(tempDir, "package.json"), "{}");

    // Build artifact with a provenance entry that predates the file
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const artifact = makeArtifactWithProvenance(
      {
        "context.architecture": {
          source: "detected",
          updatedAt: pastDate,
          supportingFiles: ["package.json"],
        },
      },
      tempDir,
    );

    const result = markStaleProvenanceEntries(artifact, tempDir);

    const entry = result.effective.provenance["context.architecture" as RepoContextLeafPath];
    expect(entry?.note).toBe("stale: supporting file changed");
  });

  it("preserves entries whose supporting files have not changed", async () => {
    await writeFile(join(tempDir, "package.json"), "{}");

    // Build artifact with a provenance entry that postdates the file
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const artifact = makeArtifactWithProvenance(
      {
        "context.architecture": {
          source: "detected",
          updatedAt: futureDate,
          supportingFiles: ["package.json"],
        },
      },
      tempDir,
    );

    const result = markStaleProvenanceEntries(artifact, tempDir);

    // Should return the same object reference — nothing changed
    expect(result).toBe(artifact);
  });

  it("marks only affected entries stale, preserving unrelated entries", async () => {
    await writeFile(join(tempDir, "package.json"), "{}");
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "main.ts"), "export const x = 1;");

    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    const artifact = makeArtifactWithProvenance(
      {
        "context.architecture": {
          source: "detected",
          updatedAt: pastDate,
          supportingFiles: ["package.json"],
        },
        "context.concepts.stack": {
          source: "detected",
          updatedAt: futureDate,
          supportingFiles: ["src/main.ts"],
        },
      },
      tempDir,
    );

    const result = markStaleProvenanceEntries(artifact, tempDir);

    expect(result.effective.provenance["context.architecture" as RepoContextLeafPath]?.note).toBe(
      "stale: supporting file changed",
    );
    expect(
      result.effective.provenance["context.concepts.stack" as RepoContextLeafPath]?.note,
    ).toBeUndefined();
  });

  it("treats missing supporting files as stale", async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const artifact = makeArtifactWithProvenance(
      {
        "context.architecture": {
          source: "detected",
          updatedAt: pastDate,
          supportingFiles: ["nonexistent-file.json"],
        },
      },
      tempDir,
    );

    const result = markStaleProvenanceEntries(artifact, tempDir);

    expect(result.effective.provenance["context.architecture" as RepoContextLeafPath]?.note).toBe(
      "stale: supporting file changed",
    );
  });
});
