import { createHash } from "crypto";
import { execSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  mergeRepoContextLayers,
  type RepoContextArtifact,
  type RepoContextLeafPath,
  type RepoFreshnessSignature,
} from "#domain/context.js";

// ─── Manifest candidates ───────────────────────────────────────────────────

const ROOT_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
] as const;

const collectManifestCandidates = (cwd: string): string[] => {
  const candidates: string[] = [];

  for (const name of ROOT_MANIFESTS) {
    const full = join(cwd, name);
    if (existsSync(full)) {
      candidates.push(name);
    }
  }

  // tsconfig.*.json variants in root
  try {
    for (const entry of readdirSync(cwd)) {
      if (entry !== "tsconfig.json" && /^tsconfig\..*\.json$/.test(entry) && existsSync(join(cwd, entry))) {
        candidates.push(entry);
      }
    }
  } catch {
    /* root not readable — skip */
  }

  // *.sln / *.slnx in root
  try {
    for (const entry of readdirSync(cwd)) {
      if (/\.(sln|slnx)$/.test(entry)) {
        candidates.push(entry);
      }
    }
  } catch {
    /* skip */
  }

  // *.csproj in src/
  const srcDir = join(cwd, "src");
  if (existsSync(srcDir)) {
    try {
      for (const entry of readdirSync(srcDir)) {
        if (entry.endsWith(".csproj")) {
          candidates.push(`src/${entry}`);
        }
      }
    } catch {
      /* skip */
    }
  }

  return candidates.sort();
};

// ─── Signature computation ─────────────────────────────────────────────────

const resolveHeadSync = (cwd: string): string | null => {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
};

const hashManifests = (cwd: string, candidates: readonly string[]): string => {
  const hash = createHash("sha256");

  for (const name of candidates) {
    const full = join(cwd, name);
    try {
      const stat = statSync(full);
      hash.update(`${name}:${stat.mtimeMs}:${stat.size}\n`);
    } catch {
      /* file vanished between collect and hash — skip */
    }
  }

  return hash.digest("hex");
};

export const computeFreshnessSignature = (cwd: string): RepoFreshnessSignature | undefined => {
  const head = resolveHeadSync(cwd);
  if (head === null) {
    return undefined;
  }

  const candidates = collectManifestCandidates(cwd);
  const manifestHash = hashManifests(cwd, candidates);

  return { head, manifestHash };
};

// ─── Freshness check ───────────────────────────────────────────────────────

export const isContextFresh = (artifact: RepoContextArtifact, cwd: string): boolean => {
  if (artifact.freshness === undefined) {
    return false;
  }

  const current = computeFreshnessSignature(cwd);
  if (current === undefined) {
    return false;
  }

  return artifact.freshness.head === current.head &&
    artifact.freshness.manifestHash === current.manifestHash;
};

// ─── Provenance staleness ──────────────────────────────────────────────────

const isFileMtimeAfter = (filePath: string, isoTimestamp: string): boolean => {
  try {
    const stat = statSync(filePath);
    return stat.mtimeMs > new Date(isoTimestamp).getTime();
  } catch {
    // File doesn't exist — treat as changed (stale)
    return true;
  }
};

export const markStaleProvenanceEntries = (
  artifact: RepoContextArtifact,
  cwd: string,
): RepoContextArtifact => {
  let changed = false;

  const updatedProvenance = { ...artifact.effective.provenance };

  for (const [path, entry] of Object.entries(artifact.effective.provenance)) {
    const files = entry.supportingFiles;
    if (files === undefined || files.length === 0) {
      continue;
    }

    // Already marked stale — skip
    if (entry.note?.startsWith("stale:")) {
      continue;
    }

    const anyChanged = files.some((f) => isFileMtimeAfter(join(cwd, f), entry.updatedAt));
    if (anyChanged) {
      changed = true;
      updatedProvenance[path as RepoContextLeafPath] = {
        ...entry,
        note: "stale: supporting file changed",
      };
    }
  }

  if (!changed) {
    return artifact;
  }

  return {
    ...artifact,
    effective: {
      context: mergeRepoContextLayers(artifact.layers).context,
      provenance: updatedProvenance,
    },
  };
};
