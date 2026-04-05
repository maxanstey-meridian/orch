import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { RepoContextArtifact } from "#domain/context.js";
import { parseRepoContextArtifact, repoContextArtifactSchema } from "./context-schema.js";

export const contextFilePath = (outputDir: string): string => join(outputDir, "context.json");

export const loadRepoContext = (outputDir: string): RepoContextArtifact | null => {
  const filePath = contextFilePath(outputDir);
  if (!existsSync(filePath)) {
    return null;
  }

  return parseRepoContextArtifact(readFileSync(filePath, "utf-8"), filePath);
};

export const tryLoadRepoContext = (outputDir: string): RepoContextArtifact | null => {
  try {
    return loadRepoContext(outputDir);
  } catch {
    return null;
  }
};

export const saveRepoContext = (outputDir: string, artifact: RepoContextArtifact): string => {
  const filePath = contextFilePath(outputDir);
  mkdirSync(outputDir, { recursive: true });
  const validated = repoContextArtifactSchema.parse(artifact);
  writeFileSync(filePath, JSON.stringify(validated, null, 2));
  return filePath;
};
