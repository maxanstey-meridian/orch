import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import {
  createEmptyRepoContextArtifact,
  createEmptyRepoContextLayer,
  flattenRepoContextData,
  mergeRepoContextLayers,
  type RepoContextArtifact,
  type RepoContextData,
  type RepoContextEntryProvenance,
  type RepoContextLayer,
  type RepoContextSourceName,
} from "#domain/context.js";
import { parseProfileMarkdown } from "#ui/init.js";
import { renderBriefFromContext } from "./context/context-brief.js";
import {
  computeFreshnessSignature,
  isContextFresh,
  markStaleProvenanceEntries,
} from "./context/context-freshness.js";
import { loadRepoContext, saveRepoContext, tryLoadRepoContext } from "./context/context-store.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type StackInfo = {
  readonly lang: string;
  readonly framework: string;
  readonly target: string;
  readonly deps: string[];
};

export type FingerprintResult = {
  readonly brief: string;
  readonly context: RepoContextArtifact;
};

type FingerprintOptions = {
  readonly cwd: string;
  readonly outputDir: string;
  readonly skip?: boolean;
  readonly forceRefresh?: boolean;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const fileExists = (p: string): boolean => existsSync(p);

const tryRead = (p: string): string => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
};

const tryParseJson = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Narrow an unknown value to a string-keyed object, or undefined. */
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Narrow an unknown value to a string array, or undefined. */
const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;

const findFiles = (root: string, pattern: string, searchDirs = ["src", "tests"]): string[] => {
  try {
    const paths = searchDirs
      .filter((d) => existsSync(join(root, d)))
      .map((d) => join(root, d))
      .join(" ");
    if (!paths) {
      return [];
    }
    return execSync(
      `find ${paths} -type f -name "${pattern}" ! -path "*/obj/*" ! -path "*/bin/*" ! -path "*/node_modules/*" 2>/dev/null`,
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => relative(root, p));
  } catch {
    return [];
  }
};

const dirTree = (root: string, dir: string, depth = 1): string[] => {
  const abs = join(root, dir);
  if (!existsSync(abs)) {
    return [];
  }
  const entries = readdirSync(abs, { withFileTypes: true });
  const dirs = entries.filter(
    (e) =>
      e.isDirectory() &&
      !e.name.startsWith(".") &&
      e.name !== "node_modules" &&
      e.name !== "bin" &&
      e.name !== "obj",
  );
  const result: string[] = [];
  for (const d of dirs) {
    result.push(`${dir}/${d.name}/`);
    if (depth > 1) {
      result.push(...dirTree(root, `${dir}/${d.name}`, depth - 1));
    }
  }
  return result;
};

// ─── Detectors ──────────────────────────────────────────────────────────────

export const detectStack = (root: string): StackInfo => {
  // .NET — only search src/ and tests/ (matches original behaviour)
  const csprojs = findFiles(root, "*.csproj");

  if (csprojs.length > 0) {
    const allContent = csprojs.map((p) => tryRead(join(root, p))).join("\n");
    const tfm = allContent.match(/<TargetFramework>(.*?)<\/TargetFramework>/)?.[1] ?? "unknown";
    const deps = [...allContent.matchAll(/<PackageReference Include="(.*?)"/g)].map((m) => m[1]);
    const uniqueDeps = [...new Set(deps)];
    const hasAspNet =
      uniqueDeps.some((d) => d.includes("AspNetCore")) ||
      allContent.includes("Microsoft.NET.Sdk.Web");
    const hasRoslyn = uniqueDeps.some((d) => d.includes("CodeAnalysis"));
    const framework = hasAspNet
      ? "ASP.NET Core"
      : hasRoslyn
        ? "Roslyn analysis tool"
        : "console/library";
    return { lang: "C#", framework, target: tfm, deps: uniqueDeps };
  }

  // TypeScript/Node
  const pkgPath = join(root, "package.json");
  if (fileExists(pkgPath)) {
    const pkg = tryParseJson(tryRead(pkgPath));
    if (!pkg) {
      return { lang: "unknown", framework: "unknown", target: "unknown", deps: [] };
    }
    const deps = [
      ...Object.keys(asRecord(pkg.dependencies) ?? {}),
      ...Object.keys(asRecord(pkg.devDependencies) ?? {}),
    ];
    const framework = deps.includes("next")
      ? "Next.js"
      : deps.includes("nuxt")
        ? "Nuxt"
        : deps.includes("@nestjs/core")
          ? "NestJS"
          : deps.includes("express")
            ? "Express"
            : "Node.js";
    const engines = asRecord(pkg.engines);
    const node: string = typeof engines?.node === "string" ? engines.node : "unknown";
    return { lang: "TypeScript", framework, target: node, deps };
  }

  return { lang: "unknown", framework: "unknown", target: "unknown", deps: [] };
};

export const detectProjects = (root: string): string[] => {
  // .NET solution files
  let rootFiles: string[];
  try {
    rootFiles = readdirSync(root).filter((f) => f.endsWith(".sln") || f.endsWith(".slnx"));
  } catch {
    return [];
  }
  for (const sln of rootFiles) {
    const content = tryRead(join(root, sln));
    const projects = [...content.matchAll(/Path="(.*?)"/g)].map((m) => m[1]);
    if (projects.length > 0) {
      return projects;
    }
  }

  // Package.json workspaces
  const pkgPath = join(root, "package.json");
  if (fileExists(pkgPath)) {
    const pkg = tryParseJson(tryRead(pkgPath));
    if (!pkg) {
      return [];
    }
    const ws = pkg.workspaces;
    if (ws) {
      const arr = asStringArray(ws);
      if (arr) {
        return arr;
      }
      const obj = asRecord(ws);
      if (obj) {
        return asStringArray(obj.packages) ?? [];
      }
    }
  }

  return [];
};

export const detectFolderStructure = (root: string): string[] => {
  const srcDirs = dirTree(root, "src", 2);
  const testDirs = dirTree(root, "tests", 1);
  return [...srcDirs, ...testDirs];
};

export const detectArchPattern = (folders: string[]): string => {
  const flat = folders.map((f) => f.toLowerCase());
  const hasModules = flat.some((f) => f.includes("/modules/"));
  const hasDomain = flat.some((f) => f.includes("/domain"));
  const hasApplication = flat.some(
    (f) => f.includes("/application") || f.includes("/import") || f.includes("/mapping"),
  );
  const hasPipeline = flat.some((f) => f.includes("/pipeline"));
  const hasPorts = flat.some((f) => f.includes("/ports/"));

  if (hasModules && hasPorts) {
    return "VSA + Clean Architecture modular monolith";
  }
  if (hasDomain && hasApplication && hasPorts) {
    return "Clean Architecture (ports & adapters)";
  }
  if (hasPipeline) {
    return "Pipeline architecture (stateless stages + mutable accumulator)";
  }
  if (hasDomain && hasApplication) {
    return "Layered architecture";
  }
  return "Flat structure";
};

export const detectTestStyle = (root: string): string => {
  const testFiles = findFiles(root, "*Tests.cs");
  if (testFiles.length === 0) {
    const tsTests = findFiles(root, "*.test.ts");
    if (tsTests.length === 0) {
      return "No tests found";
    }
    const sample = tryRead(join(root, tsTests[0]));
    if (sample.includes("vitest")) {
      return "Vitest";
    }
    if (sample.includes("jest")) {
      return "Jest";
    }
    return "Unknown TS test framework";
  }

  const sample = tryRead(join(root, testFiles[0]));
  if (sample.includes("xUnit") || sample.includes("[Fact]") || sample.includes("[Theory]")) {
    return "xUnit";
  }
  if (sample.includes("[Test]") || sample.includes("[TestFixture]")) {
    return "NUnit";
  }
  if (sample.includes("[TestMethod]")) {
    return "MSTest";
  }
  return "Unknown .NET test framework";
};

export const detectCodePatterns = (root: string, files: string[]): string[] => {
  const patterns: string[] = [];
  const seen = new Set<string>();

  const sampleFiles = files
    .filter((f) => f.endsWith(".cs") && !f.includes("Tests") && !f.includes("obj/"))
    .slice(0, 15);

  for (const f of sampleFiles) {
    const content = tryRead(join(root, f));
    if (!content) {
      continue;
    }

    if (!seen.has("static") && /public static class \w+/.test(content)) {
      seen.add("static");
      patterns.push("Static classes for stateless pipeline stages (pure functions, no DI)");
    }
    if (!seen.has("sealed-record") && /sealed record \w+/.test(content)) {
      seen.add("sealed-record");
      patterns.push("Sealed record discriminated unions (private ctor on abstract base)");
    }
    if (!seen.has("sealed-class") && /public sealed class \w+/.test(content)) {
      seen.add("sealed-class");
      patterns.push("Sealed classes for stateful accumulators (TypeMapper pattern)");
    }
    if (!seen.has("file-ns") && /^namespace [\w.]+;$/m.test(content)) {
      seen.add("file-ns");
      patterns.push("File-scoped namespaces");
    }
    if (
      !seen.has("no-di") &&
      sampleFiles.indexOf(f) > 5 &&
      !content.includes("IServiceCollection") &&
      !content.includes("[Inject]")
    ) {
      seen.add("no-di");
      patterns.push("No DI container — direct static calls between stages");
    }
  }

  return patterns;
};

export const detectAntiPatterns = (root: string): string[] => {
  const csFiles = findFiles(root, "*.cs").filter(
    (f) => !f.includes("obj/") && !f.includes("Tests"),
  );
  if (csFiles.length === 0) {
    return [];
  }

  const anti: string[] = [];
  let hasInterface = false;
  let hasInheritance = false;
  let hasDynamic = false;

  for (const f of csFiles.slice(0, 20)) {
    const content = tryRead(join(root, f));
    if (
      /public interface I\w+/.test(content) &&
      !/I(TypeSymbol|NamedType|Symbol|Operation)/.test(content)
    ) {
      hasInterface = true;
    }
    if (/class \w+ : [A-Z]\w+[^,{]/.test(content) && !/: Exception/.test(content)) {
      hasInheritance = true;
    }
    if (/\bdynamic\b/.test(content) || /\bobject\?\b/.test(content)) {
      hasDynamic = true;
    }
  }

  if (!hasInterface) {
    anti.push("No service interfaces — stateless components are static classes called directly");
  }
  if (!hasInheritance) {
    anti.push("No class inheritance hierarchies — sealed records for polymorphism");
  }
  if (!hasDynamic) {
    anti.push("No dynamic/object? value carriers — everything strongly typed");
  }

  return anti;
};

const MAX_SAMPLE_LINES = 40;

export const sampleFlow = (root: string): string => {
  const candidates = [
    ...findFiles(root, "*Pipeline*.cs"),
    ...findFiles(root, "*Orchestrator*.cs"),
    ...findFiles(root, "*Program*.cs"),
    ...findFiles(root, "*index.ts"),
    ...findFiles(root, "*main.ts"),
  ];

  for (const f of candidates) {
    const content = tryRead(join(root, f));
    if (!content) {
      continue;
    }
    const lines = content.split("\n").slice(0, MAX_SAMPLE_LINES);
    const classStart = lines.findIndex((l) =>
      /public static class|public sealed class|export (const|function|async)/.test(l),
    );
    if (classStart >= 0) {
      return lines
        .slice(classStart, classStart + MAX_SAMPLE_LINES)
        .join("\n")
        .trim();
    }
  }

  return "";
};

const keyDependencySummary = (deps: readonly string[]): string | undefined => {
  const keyDeps = deps
    .filter((dep) => !dep.includes("Test") && !dep.includes("xunit") && !dep.includes("coverlet"))
    .slice(0, 6);

  return keyDeps.length > 0 ? keyDeps.join(", ") : undefined;
};

const detectKeyFiles = (root: string): Readonly<Record<string, string>> => {
  const entries: Array<readonly [string, string]> = [];
  const candidates = [
    ["src/main.ts", "Primary TypeScript entry point"],
    ["src/index.ts", "Primary TypeScript module entry point"],
    ["src/Program.cs", "Primary C# entry point"],
    ["src/main.cs", "Primary C# entry point"],
    ["CLAUDE.md", "Repository architecture decisions and hard rules"],
    ["AGENTS.md", "Repository-specific agent instructions"],
  ] as const;

  for (const [path, description] of candidates) {
    if (fileExists(join(root, path))) {
      entries.push([path, description]);
    }
  }

  return Object.fromEntries(entries);
};

const summariseFolders = (folders: readonly string[]): string | undefined => {
  if (folders.length === 0) {
    return undefined;
  }

  const summary = folders.slice(0, 8).join(", ");
  return folders.length > 8 ? `${summary}, ...` : summary;
};

const buildDetectedContextData = (
  root: string,
  precomputed?: { stack: StackInfo; testStyle: string },
): RepoContextData => {
  const stack = precomputed?.stack ?? detectStack(root);
  const projects = detectProjects(root);
  const folders = detectFolderStructure(root);
  const sourceFiles = stack.lang === "C#" ? findFiles(root, "*.cs") : findFiles(root, "*.ts");
  const patterns = detectCodePatterns(root, sourceFiles);
  const antiPatterns = detectAntiPatterns(root);
  const testStyle = precomputed?.testStyle ?? detectTestStyle(root);
  const keyFiles = detectKeyFiles(root);
  const concepts: Record<string, string> = {
    stack: `${stack.lang} / ${stack.target} / ${stack.framework}.`,
    tests: testStyle,
  };
  const conventions: Record<string, string> = {};
  const dependencySummary = keyDependencySummary(stack.deps);
  const folderSummary = summariseFolders(folders);

  if (dependencySummary !== undefined) {
    concepts.dependencies = dependencySummary;
  }
  if (projects.length > 0) {
    concepts.projects = projects.join(", ");
  }
  if (folderSummary !== undefined) {
    concepts.structure = folderSummary;
  }
  if (patterns.length > 0) {
    conventions.patterns = patterns.join("; ");
  }
  if (antiPatterns.length > 0) {
    conventions.antiPatterns = antiPatterns.join("; ");
  }

  return {
    architecture: detectArchPattern(folders),
    ...(Object.keys(keyFiles).length > 0 ? { keyFiles } : {}),
    concepts,
    ...(Object.keys(conventions).length > 0 ? { conventions } : {}),
  };
};

const buildOperatorContextData = (initProfileMarkdown: string): RepoContextData => {
  const parsed = parseProfileMarkdown(initProfileMarkdown);
  if (parsed === null) {
    return {};
  }

  const concepts: Record<string, string> = {
    language: parsed.language,
  };
  const conventions: Record<string, string> = {};
  const keyFiles = Object.fromEntries(
    (parsed.references ?? []).map((path) => [path, "Operator reference from init"]),
  );

  if (parsed.framework) {
    concepts.framework = parsed.framework;
  }
  if (parsed.extraContext) {
    concepts.notes = parsed.extraContext;
  }
  if (parsed.style) {
    conventions.style = parsed.style;
  }
  if (parsed.linting) {
    conventions.linting = parsed.linting;
  }

  return {
    ...(Object.keys(keyFiles).length > 0 ? { keyFiles } : {}),
    concepts,
    ...(Object.keys(conventions).length > 0 ? { conventions } : {}),
  };
};

const buildLayerProvenance = (params: {
  source: RepoContextSourceName;
  context: RepoContextData;
  updatedAt: string;
  supportingFiles: readonly string[];
}): RepoContextLayer => {
  const flattened = flattenRepoContextData(params.context);
  const provenanceEntries = Object.keys(flattened).map((path) => [
    path,
    {
      source: params.source,
      updatedAt: params.updatedAt,
      supportingFiles: params.supportingFiles,
    } satisfies RepoContextEntryProvenance,
  ]);

  return {
    context: params.context,
    provenance: Object.fromEntries(provenanceEntries),
  };
};

// ─── Brief builder ──────────────────────────────────────────────────────────

export const generateBrief = (
  root: string,
  precomputed?: { stack: StackInfo; testStyle: string },
): string => {
  const detected = buildDetectedContextData(root, precomputed);
  const now = new Date().toISOString();
  const artifact = {
    ...createEmptyRepoContextArtifact({ rootPath: root, generatedAt: now }),
    layers: {
      operator: createEmptyRepoContextLayer(),
      detected: buildLayerProvenance({
        source: "detected",
        context: detected,
        updatedAt: now,
        supportingFiles: ["package.json", "src", "tests"],
      }),
      planner: createEmptyRepoContextLayer(),
    },
  };

  return renderBriefFromContext({
    ...artifact,
    effective: mergeRepoContextLayers(artifact.layers),
  });
};

// ─── Public API ─────────────────────────────────────────────────────────────

const DEFAULTS = (cwd: string): FingerprintResult => ({
  brief: "",
  context: createEmptyRepoContextArtifact({ rootPath: cwd }),
});

export const runFingerprint = async (opts: FingerprintOptions): Promise<FingerprintResult> => {
  if (opts.skip) {
    return DEFAULTS(opts.cwd);
  }

  const initProfilePath = join(opts.outputDir, "init-profile.md");
  const initProfileMarkdown = fileExists(initProfilePath) ? tryRead(initProfilePath).trim() : "";
  const briefPath = join(opts.outputDir, "brief.md");

  // Check repo-aware freshness — reuse cached context when HEAD and manifests match
  // forceRefresh bypasses cache (e.g. after --init rewrites init-profile.md)
  if (!opts.forceRefresh) {
    const cached = tryLoadRepoContext(opts.outputDir);
    if (cached !== null && isContextFresh(cached, opts.cwd)) {
      const checked = markStaleProvenanceEntries(cached, opts.cwd);
      if (checked !== cached) {
        saveRepoContext(opts.outputDir, checked);
      }
      const brief = renderBriefFromContext(checked);
      writeFileSync(briefPath, brief);
      return { brief, context: checked };
    }
  }

  const stack = detectStack(opts.cwd);
  const testStyle = detectTestStyle(opts.cwd);
  const generatedAt = new Date().toISOString();
  const freshness = computeFreshnessSignature(opts.cwd);
  const operator = buildLayerProvenance({
    source: "operator",
    context: buildOperatorContextData(initProfileMarkdown),
    updatedAt: generatedAt,
    supportingFiles: initProfileMarkdown ? [".orch/init-profile.md"] : [],
  });
  const detected = buildLayerProvenance({
    source: "detected",
    context: buildDetectedContextData(opts.cwd, { stack, testStyle }),
    updatedAt: generatedAt,
    supportingFiles: ["package.json", "src", "tests", "CLAUDE.md", "AGENTS.md"].filter((path) =>
      fileExists(join(opts.cwd, path)),
    ),
  });
  const artifact: RepoContextArtifact = {
    ...createEmptyRepoContextArtifact({ rootPath: opts.cwd, generatedAt }),
    ...(freshness !== undefined ? { freshness } : {}),
    layers: {
      operator,
      detected,
      planner: createEmptyRepoContextLayer(),
    },
    effective: mergeRepoContextLayers({
      operator,
      detected,
      planner: createEmptyRepoContextLayer(),
    }),
  };

  // Suggest --init when project has no manifest files
  if (stack.lang === "unknown" && !initProfileMarkdown) {
    console.log("Empty project detected. Run with --init for guided setup.");
  }

  saveRepoContext(opts.outputDir, artifact);
  const storedContext = loadRepoContext(opts.outputDir);
  if (storedContext === null) {
    throw new Error(`Repo context was not persisted to ${join(opts.outputDir, "context.json")}`);
  }
  const brief = renderBriefFromContext(storedContext);
  writeFileSync(briefPath, brief);

  return { brief, context: storedContext };
};

export const wrapBrief = (brief: string): string => {
  if (!brief) {
    return "";
  }
  return `<codebase-brief>\n${brief}\n</codebase-brief>`;
};
