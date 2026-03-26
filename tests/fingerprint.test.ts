import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectStack,
  detectProjects,
  detectFolderStructure,
  detectArchPattern,
  detectTestStyle,
  detectCodePatterns,
  detectAntiPatterns,
  sampleFlow,
  runFingerprint,
  wrapBrief,
  generateBrief,
} from "../src/fingerprint.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-fp-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe("detectStack", () => {
  it("detects TypeScript project from package.json", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { express: "^4.0.0" },
        devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0" },
      }),
    );

    const result = detectStack(tempDir);
    expect(result.lang).toBe("TypeScript");
    expect(result.framework).toBe("Express");
    expect(result.deps).toContain("express");
    expect(result.deps).toContain("typescript");
  });

  it("detects C# project from .csproj", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "MyApp.csproj"),
      `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />
  </ItemGroup>
</Project>`,
    );

    const result = detectStack(tempDir);
    expect(result.lang).toBe("C#");
    expect(result.framework).toBe("ASP.NET Core");
    expect(result.target).toBe("net8.0");
    expect(result.deps).toContain("Microsoft.AspNetCore.OpenApi");
  });

  it("returns unknown when no project files exist", () => {
    const result = detectStack(tempDir);
    expect(result.lang).toBe("unknown");
    expect(result.framework).toBe("unknown");
    expect(result.deps).toEqual([]);
  });

  it("returns unknown when package.json is malformed", async () => {
    await writeFile(join(tempDir, "package.json"), "not json at all!!!");
    const result = detectStack(tempDir);
    expect(result.lang).toBe("unknown");
    expect(result.framework).toBe("unknown");
    expect(result.deps).toEqual([]);
  });

  it("detects Next.js framework", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { next: "^14.0.0" },
        devDependencies: {},
      }),
    );
    expect(detectStack(tempDir).framework).toBe("Next.js");
  });

  it("detects Nuxt framework", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { nuxt: "^3.0.0" },
        devDependencies: {},
      }),
    );
    expect(detectStack(tempDir).framework).toBe("Nuxt");
  });

  it("detects NestJS framework", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { "@nestjs/core": "^10.0.0" },
        devDependencies: {},
      }),
    );
    const result = detectStack(tempDir);
    expect(result.framework).toBe("NestJS");
  });
});

describe("detectProjects", () => {
  it("detects workspaces from package.json", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        workspaces: ["packages/core", "packages/cli"],
      }),
    );
    const result = detectProjects(tempDir);
    expect(result).toEqual(["packages/core", "packages/cli"]);
  });

  it("returns empty array when no solution or workspaces", () => {
    const result = detectProjects(tempDir);
    expect(result).toEqual([]);
  });

  it("detects projects from .sln file", async () => {
    await writeFile(
      join(tempDir, "MyApp.sln"),
      [
        "Microsoft Visual Studio Solution File, Format Version 12.00",
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Core", Path="src/Core/Core.csproj"',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", Path="src/Api/Api.csproj"',
      ].join("\n"),
    );
    const result = detectProjects(tempDir);
    expect(result).toEqual(["src/Core/Core.csproj", "src/Api/Api.csproj"]);
  });

  it("returns empty array when root does not exist", () => {
    const result = detectProjects("/tmp/nonexistent-orch-path-xyz");
    expect(result).toEqual([]);
  });

  it("returns empty array when package.json is malformed", async () => {
    await writeFile(join(tempDir, "package.json"), "{broken json");
    const result = detectProjects(tempDir);
    expect(result).toEqual([]);
  });
});

describe("detectFolderStructure", () => {
  it("reads src/ and tests/ subdirectories", async () => {
    await mkdir(join(tempDir, "src", "domain"), { recursive: true });
    await mkdir(join(tempDir, "src", "application"), { recursive: true });
    await mkdir(join(tempDir, "tests", "unit"), { recursive: true });

    const result = detectFolderStructure(tempDir);
    expect(result).toContain("src/domain/");
    expect(result).toContain("src/application/");
    expect(result).toContain("tests/unit/");
  });

  it("returns empty for empty directory", () => {
    const result = detectFolderStructure(tempDir);
    expect(result).toEqual([]);
  });
});

describe("detectArchPattern", () => {
  it("detects Clean Architecture from folder names", () => {
    const folders = ["src/domain/", "src/application/", "src/application/ports/"];
    expect(detectArchPattern(folders)).toBe("Clean Architecture (ports & adapters)");
  });

  it("detects VSA + CA modular monolith", () => {
    const folders = ["src/modules/auth/", "src/modules/auth/ports/"];
    expect(detectArchPattern(folders)).toBe("VSA + Clean Architecture modular monolith");
  });

  it("detects Pipeline architecture", () => {
    const folders = ["src/pipeline/", "src/config/"];
    expect(detectArchPattern(folders)).toBe(
      "Pipeline architecture (stateless stages + mutable accumulator)",
    );
  });

  it("defaults to Flat structure", () => {
    const folders = ["src/utils/"];
    expect(detectArchPattern(folders)).toBe("Flat structure");
  });

  it("detects Layered architecture", () => {
    const folders = ["src/domain/", "src/application/"];
    expect(detectArchPattern(folders)).toBe("Layered architecture");
  });
});

describe("detectTestStyle", () => {
  it("detects Vitest from test file content", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "foo.test.ts"),
      "import { describe, it } from 'vitest';\ndescribe('foo', () => {});",
    );
    const result = detectTestStyle(tempDir);
    expect(result).toBe("Vitest");
  });

  it("detects Jest from test file content", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "foo.test.ts"),
      "import { jest } from '@jest/globals';\ndescribe('foo', () => {});",
    );
    const result = detectTestStyle(tempDir);
    expect(result).toBe("Jest");
  });

  it("returns No tests found when no test files exist", () => {
    const result = detectTestStyle(tempDir);
    expect(result).toBe("No tests found");
  });

  it("detects xUnit from [Fact] attribute", async () => {
    await mkdir(join(tempDir, "tests"), { recursive: true });
    await writeFile(
      join(tempDir, "tests", "FooTests.cs"),
      "using Xunit;\npublic class FooTests { [Fact] public void It_works() {} }",
    );
    expect(detectTestStyle(tempDir)).toBe("xUnit");
  });

  it("detects NUnit from [Test] attribute", async () => {
    await mkdir(join(tempDir, "tests"), { recursive: true });
    await writeFile(
      join(tempDir, "tests", "BarTests.cs"),
      "using NUnit;\n[TestFixture] public class BarTests { [Test] public void It_works() {} }",
    );
    expect(detectTestStyle(tempDir)).toBe("NUnit");
  });

  it("detects MSTest from [TestMethod] attribute", async () => {
    await mkdir(join(tempDir, "tests"), { recursive: true });
    await writeFile(
      join(tempDir, "tests", "BazTests.cs"),
      "using Microsoft.VisualStudio.TestTools;\npublic class BazTests { [TestMethod] public void It_works() {} }",
    );
    expect(detectTestStyle(tempDir)).toBe("MSTest");
  });
});

describe("detectAntiPatterns", () => {
  it("returns empty array when no C# files exist (non-C# codebase)", () => {
    const result = detectAntiPatterns(tempDir);
    expect(result).toEqual([]);
  });

  it("reports all three anti-patterns for clean C# files", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "Mapper.cs"),
      "public static class TypeMapper { public static void Map() {} }",
    );
    const result = detectAntiPatterns(tempDir);
    expect(result).toHaveLength(3);
    expect(result).toContain(
      "No service interfaces — stateless components are static classes called directly",
    );
    expect(result).toContain("No class inheritance hierarchies — sealed records for polymorphism");
    expect(result).toContain("No dynamic/object? value carriers — everything strongly typed");
  });

  it("suppresses interface anti-pattern when interface found", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "Ports.cs"),
      "public interface IRepository { void Save(); }",
    );
    const result = detectAntiPatterns(tempDir);
    expect(result).not.toContain(
      "No service interfaces — stateless components are static classes called directly",
    );
  });

  it("suppresses inheritance anti-pattern when class inheritance found", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "Base.cs"), "public class Dog : Animal { }");
    const result = detectAntiPatterns(tempDir);
    expect(result).not.toContain(
      "No class inheritance hierarchies — sealed records for polymorphism",
    );
  });

  it("suppresses dynamic anti-pattern when dynamic keyword found", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "Util.cs"), "public class Util { dynamic foo = 42; }");
    const result = detectAntiPatterns(tempDir);
    expect(result).not.toContain("No dynamic/object? value carriers — everything strongly typed");
  });
});

describe("detectCodePatterns", () => {
  it("detects static classes, sealed records, sealed classes, and file-scoped namespaces", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "Pipeline.cs"),
      "namespace MyApp.Pipeline;\npublic static class Mapper { }",
    );
    await writeFile(
      join(tempDir, "src", "Types.cs"),
      "public sealed record Foo(string Name);\npublic sealed class Bar { }",
    );

    const files = ["src/Pipeline.cs", "src/Types.cs"];
    const result = detectCodePatterns(tempDir, files);
    expect(result).toContain(
      "Static classes for stateless pipeline stages (pure functions, no DI)",
    );
    expect(result).toContain("Sealed record discriminated unions (private ctor on abstract base)");
    expect(result).toContain("Sealed classes for stateful accumulators (TypeMapper pattern)");
    expect(result).toContain("File-scoped namespaces");
  });

  it("returns empty array when no C# files in list", () => {
    const result = detectCodePatterns(tempDir, ["src/foo.ts"]);
    expect(result).toEqual([]);
  });
});

describe("sampleFlow", () => {
  it("extracts code starting from export const in a main.ts file", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    const lines = ["// header comment", "export const main = () => {"];
    for (let i = 0; i < 50; i++) lines.push(`  // line ${i}`);
    lines.push("};");
    await writeFile(join(tempDir, "src", "main.ts"), lines.join("\n"));

    const result = sampleFlow(tempDir);
    expect(result).toContain("export const main");
    // Should be capped at MAX_SAMPLE_LINES (40 lines from classStart)
    const resultLines = result.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(40);
  });

  it("returns empty string when no candidate files exist", () => {
    expect(sampleFlow(tempDir)).toBe("");
  });
});

describe("runFingerprint", () => {
  it("generates brief, writes to disk, and returns profile for TS project", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {},
        devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0" },
      }),
    );
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "foo.test.ts"),
      "import { describe } from 'vitest';\ndescribe('x', () => {});",
    );

    const outputDir = join(tempDir, ".orch");
    const result = await runFingerprint({ cwd: tempDir, outputDir });

    expect(result.brief).toContain("# Codebase Brief");
    expect(result.brief).toContain("TypeScript");
    expect(result.profile.stack).toBe("TypeScript");
    // Verify brief was written to disk
    const onDisk = await readFile(join(outputDir, "brief.md"), "utf-8");
    expect(onDisk).toBe(result.brief);
  });

  it("returns defaults when skip is true", async () => {
    const result = await runFingerprint({
      cwd: tempDir,
      outputDir: join(tempDir, ".orch"),
      skip: true,
    });
    expect(result.brief).toBe("");
    expect(result.profile).toEqual({});
  });

  it("returns cached brief on second call without regenerating", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {},
        devDependencies: { typescript: "^5.0.0" },
      }),
    );

    const outputDir = join(tempDir, ".orch");
    const first = await runFingerprint({ cwd: tempDir, outputDir });
    const second = await runFingerprint({ cwd: tempDir, outputDir });

    expect(second.brief.trim()).toBe(first.brief.trim());
    expect(second.profile.stack).toBe(first.profile.stack);
  });

  it("forceRefresh regenerates a fresh brief instead of returning cache", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {},
        devDependencies: { typescript: "^5.0.0" },
      }),
    );

    const outputDir = join(tempDir, ".orch");

    // First call generates the brief
    const first = await runFingerprint({ cwd: tempDir, outputDir });
    expect(first.brief).toContain("TypeScript");

    // Tamper with the cached brief to detect if it's re-read vs regenerated
    await writeFile(join(outputDir, "brief.md"), "STALE CACHE");

    // Without forceRefresh — returns cached (stale) content
    const cached = await runFingerprint({ cwd: tempDir, outputDir });
    expect(cached.brief).toBe("STALE CACHE");

    // With forceRefresh — regenerates, overwrites stale cache
    const forced = await runFingerprint({ cwd: tempDir, outputDir, forceRefresh: true });
    expect(forced.brief).toContain("TypeScript");
    expect(forced.brief).not.toContain("STALE CACHE");
  });

  it("skip takes priority over forceRefresh — returns defaults", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {},
        devDependencies: { typescript: "^5.0.0" },
      }),
    );

    const result = await runFingerprint({
      cwd: tempDir,
      outputDir: join(tempDir, ".orch"),
      skip: true,
      forceRefresh: true,
    });
    expect(result.brief).toBe("");
    expect(result.profile).toEqual({});
  });

  it("returns dotnet test for C# project with xUnit tests", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await mkdir(join(tempDir, "tests"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "App.csproj"),
      `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
</Project>`,
    );
    await writeFile(
      join(tempDir, "tests", "FooTests.cs"),
      "using Xunit;\npublic class FooTests { [Fact] public void It() {} }",
    );

    const result = await runFingerprint({ cwd: tempDir, outputDir: join(tempDir, ".orch") });
    expect(result.profile.stack).toBe("C#");
  });

  it("returns npx jest for Jest project", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {},
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "foo.test.ts"),
      "import { jest } from '@jest/globals';\ndescribe('x', () => {});",
    );

    const result = await runFingerprint({ cwd: tempDir, outputDir: join(tempDir, ".orch") });
    expect(result.profile.stack).toBe("TypeScript");
  });
});

describe("wrapBrief", () => {
  it("returns empty string for empty brief", () => {
    expect(wrapBrief("")).toBe("");
  });

  it("wraps non-empty brief in codebase-brief tags", () => {
    const brief = "# Codebase Brief\n\nTypeScript project.";
    const wrapped = wrapBrief(brief);
    expect(wrapped).toContain("<codebase-brief>");
    expect(wrapped).toContain("</codebase-brief>");
    expect(wrapped).toContain(brief);
  });
});

describe("generateBrief", () => {
  it("includes stack and architecture sections", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {},
        devDependencies: { typescript: "^5.0.0" },
      }),
    );

    const brief = generateBrief(tempDir);
    expect(brief).toContain("## Stack");
    expect(brief).toContain("TypeScript");
    expect(brief).toContain("## Architecture");
  });
});
