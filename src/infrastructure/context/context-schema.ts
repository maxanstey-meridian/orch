import { z } from "zod";
import type {
  RepoContextArtifact,
  RepoContextData,
  RepoContextEntryProvenance,
  RepoContextLayer,
} from "#domain/context.js";

const contextDictionarySchema = z.record(z.string().min(1), z.string().min(1));
const repoContextLayerNames = ["operator", "detected", "planner"] as const;

export const repoContextDataSchema = z
  .object({
    architecture: z.string().min(1).optional(),
    keyFiles: contextDictionarySchema.optional(),
    concepts: contextDictionarySchema.optional(),
    conventions: contextDictionarySchema.optional(),
  })
  .strict();

export const repoContextEntryProvenanceSchema = z
  .object({
    source: z.enum(repoContextLayerNames),
    updatedAt: z.string().min(1),
    supportingFiles: z.array(z.string().min(1)).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

export const repoContextLayerSchema = z
  .object({
    context: repoContextDataSchema,
    provenance: z.record(z.string().min(1), repoContextEntryProvenanceSchema),
  })
  .strict();

export const repoContextArtifactSchema = z
  .object({
    version: z.literal(1),
    repo: z
      .object({
        rootPath: z.string().min(1),
        repoName: z.string().min(1),
        generatedAt: z.string().min(1),
      })
      .strict(),
    layers: z
      .object({
        operator: repoContextLayerSchema,
        detected: repoContextLayerSchema,
        planner: repoContextLayerSchema,
      })
      .strict(),
    effective: repoContextLayerSchema,
  })
  .strict();

export const parseRepoContextArtifact = (
  raw: string,
  source = "<json>",
): RepoContextArtifact => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in repo context: ${source} — ${(error as Error).message}`);
  }

  const result = repoContextArtifactSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid repo context (${source}):\n${issues.join("\n")}`);
  }

  return result.data;
};

export const assertRepoContextData = (context: RepoContextData): RepoContextData =>
  repoContextDataSchema.parse(context);

export const assertRepoContextLayer = (layer: RepoContextLayer): RepoContextLayer =>
  repoContextLayerSchema.parse(layer);

export const assertRepoContextEntryProvenance = (
  provenance: RepoContextEntryProvenance,
): RepoContextEntryProvenance => repoContextEntryProvenanceSchema.parse(provenance);
