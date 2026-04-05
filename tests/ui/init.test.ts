import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";
import {
  runInit,
  profileToMarkdown,
  parseProfileMarkdown,
  type InitProfile,
  type AskFn,
  type AskHandle,
} from "#ui/init.js";
import { runFingerprint } from "#infrastructure/fingerprint.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock ask function that returns answers in order. */
const mockAsk = (answers: string[]): AskFn => {
  let i = 0;
  return async (_prompt: string) => answers[i++] ?? "";
};

// ─── runInit ────────────────────────────────────────────────────────────────

describe("runInit", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "init-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns complete profile when all questions answered", async () => {
    const refPath = join(tmpDir, "CLAUDE.md");
    writeFileSync(refPath, "# Guide");

    const ask = mockAsk([
      "TypeScript",
      "NestJS",
      "Clean Architecture, camelCase",
      "oxlint + oxfmt",
      refPath,
      "This is a monorepo",
    ]);

    const result = await runInit(tmpDir, ask);

    expect(result).toEqual({
      language: "TypeScript",
      framework: "NestJS",
      style: "Clean Architecture, camelCase",
      linting: "oxlint + oxfmt",
      references: [refPath],
      extraContext: "This is a monorepo",
    });
  });

  it("returns null when language is empty (abort)", async () => {
    const result = await runInit(tmpDir, mockAsk([""]));
    expect(result).toBeNull();
  });

  it("returns profile with only language when other answers are empty", async () => {
    const result = await runInit(tmpDir, mockAsk(["Python", "", "", "", "", ""]));
    expect(result).toEqual({ language: "Python" });
  });

  it("filters out non-existent reference paths with warning", async () => {
    const existingRef = join(tmpDir, "style.md");
    writeFileSync(existingRef, "# Style");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ask = mockAsk([
      "TypeScript",
      "",
      "",
      "",
      `${existingRef}, /does/not/exist.md, ${join(tmpDir, "also-missing.md")}`,
      "",
    ]);

    const result = await runInit(tmpDir, ask);

    expect(result?.references).toEqual([existingRef]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toContain("/does/not/exist.md");

    warnSpy.mockRestore();
  });

  it("returns no references key when all reference paths are non-existent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ask = mockAsk([
      "TypeScript",
      "",
      "",
      "",
      "/does/not/exist.md, /also/nope.md",
      "",
    ]);

    const result = await runInit(tmpDir, ask);

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("references");
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it("returns no references key for degenerate comma input like ', , ,'", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ask = mockAsk([
      "TypeScript",
      "",
      "",
      "",
      ", , ,,",
      "",
    ]);

    const result = await runInit(tmpDir, ask);

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("references");
    // No warnings because filter(Boolean) removes empty strings before checking existence
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("resolves relative reference paths against cwd", async () => {
    // Create a file inside tmpDir
    writeFileSync(join(tmpDir, "guide.md"), "# Guide");

    const ask = mockAsk([
      "TypeScript",
      "",
      "",
      "",
      "guide.md",  // relative path — should resolve against cwd (tmpDir)
      "",
    ]);

    const result = await runInit(tmpDir, ask);

    // Should store the absolute resolved path, not the raw relative input
    expect(result?.references).toEqual([resolve(tmpDir, "guide.md")]);
  });

  it("calls close() on AskHandle when provided", async () => {
    let closed = false;
    const handle: AskHandle = {
      ask: mockAsk(["TypeScript", "", "", "", "", ""]),
      close: () => { closed = true; },
    };

    await runInit(tmpDir, handle);

    expect(closed).toBe(true);
  });

  it("calls close() on AskHandle even when language is empty (abort)", async () => {
    let closed = false;
    const handle: AskHandle = {
      ask: mockAsk([""]),
      close: () => { closed = true; },
    };

    await runInit(tmpDir, handle);

    expect(closed).toBe(true);
  });
});

// ─── profileToMarkdown ──────────────────────────────────────────────────────

describe("profileToMarkdown", () => {
  it("produces expected markdown format for full profile", () => {
    const profile: InitProfile = {
      language: "TypeScript",
      framework: "NestJS",
      style: "camelCase, Clean Architecture, no inheritance",
      linting: "oxlint + oxfmt",
      references: ["../CLAUDE.md"],
      extraContext: "This is a monorepo, the API is in packages/api/",
    };

    const md = profileToMarkdown(profile);

    expect(md).toContain("## Project Profile (from init)");
    expect(md).toContain("- **Language:** TypeScript");
    expect(md).toContain("- **Framework:** NestJS");
    expect(md).toContain("- **Style:** camelCase, Clean Architecture, no inheritance");
    expect(md).toContain("- **Linting:** oxlint + oxfmt");
    expect(md).toContain("- **References:** ../CLAUDE.md");
    expect(md).toContain("- **Notes:** This is a monorepo, the API is in packages/api/");
  });

  it("omits References line when references is empty array", () => {
    const md = profileToMarkdown({ language: "Go", references: [] });

    expect(md).toContain("- **Language:** Go");
    expect(md).not.toContain("References");
  });

  it("omits optional fields when not present", () => {
    const md = profileToMarkdown({ language: "Go" });

    expect(md).toContain("- **Language:** Go");
    expect(md).not.toContain("Framework");
    expect(md).not.toContain("Style");
    expect(md).not.toContain("Linting");
    expect(md).not.toContain("References");
    expect(md).not.toContain("Notes");
  });
});

describe("parseProfileMarkdown", () => {
  it("round-trips markdown generated by profileToMarkdown", () => {
    const profile: InitProfile = {
      language: "TypeScript",
      framework: "NestJS",
      style: "Clean Architecture",
      linting: "oxlint + oxfmt",
      references: ["../CLAUDE.md", "./AGENTS.md"],
      extraContext: "Monorepo with a single orchestration package",
    };

    expect(parseProfileMarkdown(profileToMarkdown(profile))).toEqual(profile);
  });

  it("returns null for unexpected markdown", () => {
    expect(parseProfileMarkdown("# Not an init profile")).toBeNull();
  });
});

// ─── Init profile merges with fingerprint brief ─────────────────────────────

describe("init profile + fingerprint integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "init-fp-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("translates init profile markdown into structured operator context", async () => {
    const orchDir = join(tmpDir, ".orch");
    mkdirSync(orchDir, { recursive: true });

    const initContent = profileToMarkdown({ language: "TypeScript", framework: "Express" });
    writeFileSync(join(orchDir, "init-profile.md"), initContent);

    const result = await runFingerprint({
      cwd: tmpDir,
      outputDir: orchDir,
    });

    expect(result.context.layers.operator.context).toEqual({
      concepts: {
        language: "TypeScript",
        framework: "Express",
      },
    });
    expect(result.brief).toContain("# Codebase Brief");
    expect(result.brief).toContain("**language:** TypeScript");
    expect(result.brief).toContain("**framework:** Express");
  });

  it("generates no operator layer when no init-profile.md exists", async () => {
    const orchDir = join(tmpDir, ".orch");

    const result = await runFingerprint({
      cwd: tmpDir,
      outputDir: orchDir,
    });

    expect(result.context.layers.operator.context).toEqual({});
    expect(result.brief).toContain("# Codebase Brief");
  });

  it("forceRefresh reparses init profile markdown when operator context changes", async () => {
    const orchDir = join(tmpDir, ".orch");
    mkdirSync(orchDir, { recursive: true });

    // First run — write init profile with "Express"
    writeFileSync(join(orchDir, "init-profile.md"), profileToMarkdown({ language: "TypeScript", framework: "Express" }));
    const first = await runFingerprint({ cwd: tmpDir, outputDir: orchDir });
    expect(first.context.layers.operator.context.concepts?.framework).toBe("Express");

    // Update init profile to "NestJS" — without forceRefresh, cache returns stale brief
    writeFileSync(join(orchDir, "init-profile.md"), profileToMarkdown({ language: "TypeScript", framework: "NestJS" }));
    const cached = await runFingerprint({ cwd: tmpDir, outputDir: orchDir });
    expect(cached.context.layers.operator.context.concepts?.framework).toBe("Express");

    // With forceRefresh, regenerates with new init profile
    const refreshed = await runFingerprint({ cwd: tmpDir, outputDir: orchDir, forceRefresh: true });
    expect(refreshed.context.layers.operator.context.concepts?.framework).toBe("NestJS");
    expect(refreshed.brief).toContain("**framework:** NestJS");
  });
});
