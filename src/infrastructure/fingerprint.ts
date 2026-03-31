import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join, relative } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

type StackInfo = {
  readonly lang: string;
  readonly framework: string;
  readonly target: string;
  readonly deps: string[];
};

export type ProjectProfile = {
  readonly stack?: string;
};

export type FingerprintResult = {
  readonly brief: string;
  readonly profile: ProjectProfile;
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

// ─── Brief builder ──────────────────────────────────────────────────────────

export const generateBrief = (
  root: string,
  precomputed?: { stack: StackInfo; testStyle: string },
): string => {
  const stack = precomputed?.stack ?? detectStack(root);
  const projects = detectProjects(root);
  const folders = detectFolderStructure(root);
  const arch = detectArchPattern(folders);
  const testStyle = precomputed?.testStyle ?? detectTestStyle(root);
  const allSrcFiles = stack.lang === "C#" ? findFiles(root, "*.cs") : findFiles(root, "*.ts");
  const patterns = detectCodePatterns(root, allSrcFiles);
  const antiPatterns = detectAntiPatterns(root);
  const flow = sampleFlow(root);

  const lines: string[] = [
    "# Codebase Brief",
    "",
    "> Auto-generated by fingerprint.ts. Injected into agent prompts to maintain",
    "> consistency across compaction boundaries. Do not edit — regenerate instead.",
    "",
    "## Stack",
    "",
    `${stack.lang} / ${stack.target} / ${stack.framework}.`,
  ];

  if (stack.deps.length > 0) {
    const keyDeps = stack.deps
      .filter((d) => !d.includes("Test") && !d.includes("xunit") && !d.includes("coverlet"))
      .slice(0, 6);
    if (keyDeps.length > 0) {
      lines.push(`Key deps: ${keyDeps.join(", ")}.`);
    }
  }

  lines.push(`Tests: ${testStyle}.`);
  lines.push("");

  if (projects.length > 0) {
    lines.push("## Projects");
    lines.push("");
    for (const p of projects) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  }

  if (folders.length > 0) {
    lines.push("## Structure");
    lines.push("");
    lines.push("```");
    const grouped = new Map<string, string[]>();
    for (const f of folders) {
      const parts = f.split("/");
      const key = `${parts[0]}/${parts[1]}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      if (parts.length > 2) {
        grouped.get(key)!.push(parts.slice(2).join("/"));
      }
    }
    for (const [parent, children] of grouped) {
      lines.push(parent + "/");
      for (const child of children) {
        if (child) {
          lines.push(`  ${child}`);
        }
      }
    }
    lines.push("```");
    lines.push("");
  }

  lines.push("## Architecture");
  lines.push("");
  lines.push(arch);
  lines.push("");

  if (patterns.length > 0) {
    lines.push("## Patterns in use");
    lines.push("");
    for (const p of patterns) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  }

  if (antiPatterns.length > 0) {
    lines.push("## What this codebase does NOT do");
    lines.push("");
    for (const a of antiPatterns) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }

  if (flow) {
    const lang = stack.lang === "C#" ? "csharp" : "typescript";
    lines.push("## Example flow (entry point)");
    lines.push("");
    lines.push(`\`\`\`${lang}`);
    lines.push(flow);
    lines.push("```");
    lines.push("");
  }

  if (fileExists(join(root, "CLAUDE.md"))) {
    lines.push("## See also");
    lines.push("");
    lines.push(
      "CLAUDE.md has authoritative architecture decisions, change ripple map, and hard rules.",
    );
    lines.push(
      "This brief is a structural snapshot — CLAUDE.md is the source of truth for intent.",
    );
    lines.push("");
  }

  return lines.join("\n");
};

// ─── Public API ─────────────────────────────────────────────────────────────

const DEFAULTS: FingerprintResult = { brief: "", profile: {} };

const ONE_HOUR_MS = 60 * 60 * 1000;

export const runFingerprint = async (opts: FingerprintOptions): Promise<FingerprintResult> => {
  if (opts.skip) {
    return DEFAULTS;
  }

  const initProfilePath = join(opts.outputDir, "init-profile.md");
  const initPrefix = fileExists(initProfilePath) ? tryRead(initProfilePath).trim() : "";

  // Check freshness — skip if brief exists and is <1h old
  // forceRefresh bypasses cache (e.g. after --init rewrites init-profile.md)
  const briefPath = join(opts.outputDir, "brief.md");
  const profilePath = join(opts.outputDir, "profile.json");
  if (!opts.forceRefresh) {
    try {
      const stat = statSync(briefPath);
      if (Date.now() - stat.mtimeMs < ONE_HOUR_MS) {
        const brief = tryRead(briefPath).trim();
        const cachedProfile = tryParseJson(tryRead(profilePath));
        if (brief && cachedProfile) {
          const profile: ProjectProfile =
            typeof cachedProfile.stack === "string" ? { stack: cachedProfile.stack } : {};
          return { brief, profile };
        }
      }
    } catch {
      /* brief doesn't exist yet, generate it */
    }
  }

  const stack = detectStack(opts.cwd);
  const testStyle = detectTestStyle(opts.cwd);
  const generated = generateBrief(opts.cwd, { stack, testStyle });

  // Init profile takes priority — prepend operator-stated context
  const brief = initPrefix ? `${initPrefix}\n\n${generated}` : generated;

  const profile: ProjectProfile = {
    stack: stack.lang,
  };

  // Suggest --init when project has no manifest files
  if (stack.lang === "unknown" && !initPrefix) {
    console.log("Empty project detected. Run with --init for guided setup.");
  }

  // Write brief and profile to disk
  mkdirSync(opts.outputDir, { recursive: true });
  writeFileSync(briefPath, brief);
  writeFileSync(profilePath, JSON.stringify(profile));

  return { brief, profile };
};

export const wrapBrief = (brief: string): string => {
  if (!brief) {
    return "";
  }
  return `<codebase-brief>\n${brief}\n</codebase-brief>`;
};
