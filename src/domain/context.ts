export type RepoContextDictionary = Readonly<Record<string, string>>;

export type RepoFreshnessSignature = {
  readonly head: string;
  readonly manifestHash: string;
};

export type RepoContextData = {
  readonly architecture?: string;
  readonly keyFiles?: RepoContextDictionary;
  readonly concepts?: RepoContextDictionary;
  readonly conventions?: RepoContextDictionary;
};

export type RepoContextSourceName = "operator" | "detected" | "planner" | "verified";
export type RepoContextAuditableSourceName = Extract<RepoContextSourceName, "detected" | "planner">;

export type RepoContextLeafPath = `context.${string}`;

export type RepoContextEntryProvenance = {
  readonly source: RepoContextSourceName;
  readonly updatedAt: string;
  readonly supportingFiles?: readonly string[];
  readonly note?: string;
};

export type RepoContextLayer = {
  readonly context: RepoContextData;
  readonly provenance: Readonly<Record<RepoContextLeafPath, RepoContextEntryProvenance>>;
};

export type RepoContextLayers = {
  readonly operator: RepoContextLayer;
  readonly detected: RepoContextLayer;
  readonly planner: RepoContextLayer;
};

export type RepoContextArtifact = {
  readonly version: 1;
  readonly repo: {
    readonly rootPath: string;
    readonly repoName: string;
    readonly generatedAt: string;
  };
  readonly freshness?: RepoFreshnessSignature;
  readonly layers: RepoContextLayers;
  readonly effective: RepoContextLayer;
};

export const createEmptyRepoContextLayer = (): RepoContextLayer => ({
  context: {},
  provenance: {},
});

export const createEmptyRepoContextArtifact = (params: {
  rootPath: string;
  generatedAt?: string;
}): RepoContextArtifact => ({
  version: 1,
  repo: {
    rootPath: params.rootPath,
    repoName: params.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? params.rootPath,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
  },
  layers: {
    operator: createEmptyRepoContextLayer(),
    detected: createEmptyRepoContextLayer(),
    planner: createEmptyRepoContextLayer(),
  },
  effective: createEmptyRepoContextLayer(),
});

const definedEntries = (values: RepoContextDictionary | undefined): readonly [string, string][] =>
  Object.entries(values ?? {}).filter(([, value]) => value.trim().length > 0);

export const flattenRepoContextData = (
  context: RepoContextData,
): Readonly<Record<RepoContextLeafPath, string>> => {
  const entries: Array<readonly [RepoContextLeafPath, string]> = [];

  if (context.architecture?.trim()) {
    entries.push(["context.architecture", context.architecture.trim()]);
  }

  for (const [key, value] of definedEntries(context.keyFiles)) {
    entries.push([`context.keyFiles.${key}`, value]);
  }

  for (const [key, value] of definedEntries(context.concepts)) {
    entries.push([`context.concepts.${key}`, value]);
  }

  for (const [key, value] of definedEntries(context.conventions)) {
    entries.push([`context.conventions.${key}`, value]);
  }

  return Object.fromEntries(entries);
};

export const unflattenRepoContextData = (
  entries: Readonly<Record<RepoContextLeafPath, string>>,
): RepoContextData => {
  const keyFiles: Record<string, string> = {};
  const concepts: Record<string, string> = {};
  const conventions: Record<string, string> = {};
  let architecture: string | undefined;

  for (const [path, value] of Object.entries(entries)) {
    if (path === "context.architecture") {
      architecture = value;
      continue;
    }

    if (path.startsWith("context.keyFiles.")) {
      keyFiles[path.slice("context.keyFiles.".length)] = value;
      continue;
    }

    if (path.startsWith("context.concepts.")) {
      concepts[path.slice("context.concepts.".length)] = value;
      continue;
    }

    if (path.startsWith("context.conventions.")) {
      conventions[path.slice("context.conventions.".length)] = value;
    }
  }

  return {
    ...(architecture ? { architecture } : {}),
    ...(Object.keys(keyFiles).length > 0 ? { keyFiles } : {}),
    ...(Object.keys(concepts).length > 0 ? { concepts } : {}),
    ...(Object.keys(conventions).length > 0 ? { conventions } : {}),
  };
};

export const hasRepoContextData = (context: RepoContextData): boolean =>
  Object.keys(flattenRepoContextData(context)).length > 0;

export const hasRepoContextArtifact = (artifact: RepoContextArtifact | null | undefined): boolean =>
  artifact !== undefined && artifact !== null && hasRepoContextData(artifact.effective.context);

export const mergeRepoContextLayers = (layers: RepoContextLayers): RepoContextLayer => {
  const mergedEntries = new Map<RepoContextLeafPath, string>();
  const mergedProvenance = new Map<RepoContextLeafPath, RepoContextEntryProvenance>();

  for (const layer of [layers.operator, layers.planner, layers.detected]) {
    const entries = flattenRepoContextData(layer.context);
    for (const [path, value] of Object.entries(entries) as Array<[RepoContextLeafPath, string]>) {
      if (mergedEntries.has(path)) {
        continue;
      }

      mergedEntries.set(path, value);
      const provenance = layer.provenance[path];
      if (provenance !== undefined) {
        mergedProvenance.set(path, provenance);
      }
    }
  }

  return {
    context: unflattenRepoContextData(Object.fromEntries(mergedEntries)),
    provenance: Object.fromEntries(mergedProvenance),
  };
};
