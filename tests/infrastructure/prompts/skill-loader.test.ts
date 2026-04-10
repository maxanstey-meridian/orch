import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedOrchrConfig } from "#infrastructure/config/orchrc.js";
import {
  FileSystemRolePromptResolver,
  buildSkillOverrides,
  loadTieredSkills,
} from "#infrastructure/prompts/skill-loader.js";

const builtInSkill = (pathParts: readonly string[]): string =>
  readFileSync(join(process.cwd(), ...pathParts), "utf-8");

describe("FileSystemRolePromptResolver", () => {
  it("loads the built-in tiered prompt for roles with tier-specific skills", () => {
    const resolver = new FileSystemRolePromptResolver();

    expect(resolver.resolve("tdd", "medium")).toBe(builtInSkill(["skills", "medium", "build.md"]));
  });

  it("loads the shared verify prompt", () => {
    const resolver = new FileSystemRolePromptResolver();

    expect(resolver.resolve("verify", "small")).toBe(builtInSkill(["skills", "verify.md"]));
  });

  it("prefers explicit overrides and supports disabling a role", () => {
    const resolver = new FileSystemRolePromptResolver({
      review: "custom review prompt",
      gap: null,
    });

    expect(resolver.resolve("review", "medium")).toBe("custom review prompt");
    expect(resolver.resolve("gap", "medium")).toBeNull();
  });
});

describe("skill loader helpers", () => {
  const orchrc: ResolvedOrchrConfig = {
    skills: {
      tdd: { default: true },
      review: { content: "custom review prompt" },
      verify: { disabled: true },
      plan: { content: "custom plan prompt" },
      gap: { default: true },
    },
    rules: {},
    config: {},
    worktreeSetup: [],
  };

  it("builds override values from resolved skill config", () => {
    expect(buildSkillOverrides(orchrc)).toEqual({
      tdd: undefined,
      review: "custom review prompt",
      verify: null,
      plan: "custom plan prompt",
      gap: undefined,
    });
  });

  it("loads built-in skills and resolved overrides into the tiered skill set", () => {
    expect(loadTieredSkills("small", orchrc)).toEqual({
      tdd: builtInSkill(["skills", "small", "build.md"]),
      review: "custom review prompt",
      verify: null,
      plan: "custom plan prompt",
      gap: builtInSkill(["skills", "small", "gap.md"]),
      completeness: null,
    });
  });
});
