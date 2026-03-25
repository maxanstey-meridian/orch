import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectStack, detectProjects, detectFolderStructure, detectArchPattern,
  detectTestStyle, detectCodePatterns, detectAntiPatterns, sampleFlow,
  runFingerprint, wrapBrief, generateBrief,
} from './fingerprint.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-fp-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('detectStack', () => {
  it('detects TypeScript project from package.json', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.0.0' },
      devDependencies: { typescript: '^5.0.0', vitest: '^3.0.0' },
    }));

    const result = detectStack(tempDir);
    expect(result.lang).toBe('TypeScript');
    expect(result.framework).toBe('Express');
    expect(result.deps).toContain('express');
    expect(result.deps).toContain('typescript');
  });

  it('detects C# project from .csproj', async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'MyApp.csproj'), `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />
  </ItemGroup>
</Project>`);

    const result = detectStack(tempDir);
    expect(result.lang).toBe('C#');
    expect(result.framework).toBe('ASP.NET Core');
    expect(result.target).toBe('net8.0');
    expect(result.deps).toContain('Microsoft.AspNetCore.OpenApi');
  });

  it('returns unknown when no project files exist', () => {
    const result = detectStack(tempDir);
    expect(result.lang).toBe('unknown');
    expect(result.framework).toBe('unknown');
    expect(result.deps).toEqual([]);
  });

  it('returns unknown when package.json is malformed', async () => {
    await writeFile(join(tempDir, 'package.json'), 'not json at all!!!');
    const result = detectStack(tempDir);
    expect(result.lang).toBe('unknown');
    expect(result.framework).toBe('unknown');
    expect(result.deps).toEqual([]);
  });

  it('detects NestJS framework', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { '@nestjs/core': '^10.0.0' },
      devDependencies: {},
    }));
    const result = detectStack(tempDir);
    expect(result.framework).toBe('NestJS');
  });
});

describe('detectProjects', () => {
  it('detects workspaces from package.json', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      workspaces: ['packages/core', 'packages/cli'],
    }));
    const result = detectProjects(tempDir);
    expect(result).toEqual(['packages/core', 'packages/cli']);
  });

  it('returns empty array when no solution or workspaces', () => {
    const result = detectProjects(tempDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when root does not exist', () => {
    const result = detectProjects('/tmp/nonexistent-orch-path-xyz');
    expect(result).toEqual([]);
  });

  it('returns empty array when package.json is malformed', async () => {
    await writeFile(join(tempDir, 'package.json'), '{broken json');
    const result = detectProjects(tempDir);
    expect(result).toEqual([]);
  });
});

describe('detectFolderStructure', () => {
  it('reads src/ and tests/ subdirectories', async () => {
    await mkdir(join(tempDir, 'src', 'domain'), { recursive: true });
    await mkdir(join(tempDir, 'src', 'application'), { recursive: true });
    await mkdir(join(tempDir, 'tests', 'unit'), { recursive: true });

    const result = detectFolderStructure(tempDir);
    expect(result).toContain('src/domain/');
    expect(result).toContain('src/application/');
    expect(result).toContain('tests/unit/');
  });

  it('returns empty for empty directory', () => {
    const result = detectFolderStructure(tempDir);
    expect(result).toEqual([]);
  });
});

describe('detectArchPattern', () => {
  it('detects Clean Architecture from folder names', () => {
    const folders = ['src/domain/', 'src/application/', 'src/application/ports/'];
    expect(detectArchPattern(folders)).toBe('Clean Architecture (ports & adapters)');
  });

  it('detects VSA + CA modular monolith', () => {
    const folders = ['src/modules/auth/', 'src/modules/auth/ports/'];
    expect(detectArchPattern(folders)).toBe('VSA + Clean Architecture modular monolith');
  });

  it('detects Pipeline architecture', () => {
    const folders = ['src/pipeline/', 'src/config/'];
    expect(detectArchPattern(folders)).toBe('Pipeline architecture (stateless stages + mutable accumulator)');
  });

  it('defaults to Flat structure', () => {
    const folders = ['src/utils/'];
    expect(detectArchPattern(folders)).toBe('Flat structure');
  });

  it('detects Layered architecture', () => {
    const folders = ['src/domain/', 'src/application/'];
    expect(detectArchPattern(folders)).toBe('Layered architecture');
  });
});

describe('detectTestStyle', () => {
  it('detects Vitest from test file content', async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'foo.test.ts'),
      "import { describe, it } from 'vitest';\ndescribe('foo', () => {});");
    const result = detectTestStyle(tempDir);
    expect(result).toBe('Vitest');
  });

  it('detects Jest from test file content', async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'foo.test.ts'),
      "import { jest } from '@jest/globals';\ndescribe('foo', () => {});");
    const result = detectTestStyle(tempDir);
    expect(result).toBe('Jest');
  });

  it('returns No tests found when no test files exist', () => {
    const result = detectTestStyle(tempDir);
    expect(result).toBe('No tests found');
  });
});

describe('detectAntiPatterns', () => {
  it('returns empty array when no C# files exist (non-C# codebase)', () => {
    const result = detectAntiPatterns(tempDir);
    expect(result).toEqual([]);
  });
});

describe('runFingerprint', () => {
  it('generates brief, writes to disk, and returns profile for TS project', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: {},
      devDependencies: { typescript: '^5.0.0', vitest: '^3.0.0' },
    }));
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'foo.test.ts'),
      "import { describe } from 'vitest';\ndescribe('x', () => {});");

    const outputDir = join(tempDir, '.orch');
    const result = await runFingerprint({ cwd: tempDir, outputDir });

    expect(result.brief).toContain('# Codebase Brief');
    expect(result.brief).toContain('TypeScript');
    expect(result.profile.stack).toBe('TypeScript');
    expect(result.profile.testCommand).toBe('npx vitest run');

    // Verify brief was written to disk
    const onDisk = await readFile(join(outputDir, 'brief.md'), 'utf-8');
    expect(onDisk).toBe(result.brief);
  });

  it('returns defaults when skip is true', async () => {
    const result = await runFingerprint({ cwd: tempDir, outputDir: join(tempDir, '.orch'), skip: true });
    expect(result.brief).toBe('');
    expect(result.profile).toEqual({});
  });

  it('returns brief with no testCommand when no tests exist', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: {},
      devDependencies: { typescript: '^5.0.0' },
    }));

    const result = await runFingerprint({ cwd: tempDir, outputDir: join(tempDir, '.orch') });
    expect(result.brief).toContain('TypeScript');
    expect(result.profile.stack).toBe('TypeScript');
    expect(result.profile.testCommand).toBeUndefined();
  });
});

describe('wrapBrief', () => {
  it('returns empty string for empty brief', () => {
    expect(wrapBrief('')).toBe('');
  });

  it('wraps non-empty brief in codebase-brief tags', () => {
    const brief = '# Codebase Brief\n\nTypeScript project.';
    const wrapped = wrapBrief(brief);
    expect(wrapped).toContain('<codebase-brief>');
    expect(wrapped).toContain('</codebase-brief>');
    expect(wrapped).toContain(brief);
  });
});

describe('generateBrief', () => {
  it('includes stack and architecture sections', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: {},
      devDependencies: { typescript: '^5.0.0' },
    }));

    const brief = generateBrief(tempDir);
    expect(brief).toContain('## Stack');
    expect(brief).toContain('TypeScript');
    expect(brief).toContain('## Architecture');
  });
});
