import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RolePromptResolver } from "#application/ports/role-prompt-resolver.port.js";
import type { SkillOverrideSet, SkillRole, SkillSet } from "#domain/config.js";
import type { ComplexityTier } from "#domain/triage.js";
import type { ResolvedOrchrConfig } from "./config/orchrc.js";

const readBuiltInSkill = (role: SkillRole, tier: ComplexityTier): string | null => {
  const skillsDir = resolve(import.meta.dirname, "..", "..", "skills");
  const tierDir = resolve(skillsDir, tier);

  switch (role) {
    case "tdd":
      return readFileSync(resolve(tierDir, "build.md"), "utf-8");
    case "plan":
      return readFileSync(resolve(tierDir, "plan.md"), "utf-8");
    case "review":
      return readFileSync(resolve(tierDir, "review.md"), "utf-8");
    case "gap":
      return readFileSync(resolve(tierDir, "gap.md"), "utf-8");
    case "verify":
      return readFileSync(resolve(skillsDir, "verify.md"), "utf-8");
    case "completeness":
      return null;
  }
};

const resolvePromptFromOverrides = (
  role: SkillRole,
  tier: ComplexityTier,
  overrides: SkillOverrideSet | undefined,
): string | null => {
  const override = overrides?.[role];
  if (override === null) {
    return null;
  }
  if (override !== undefined) {
    return override;
  }
  return readBuiltInSkill(role, tier);
};

export class FileSystemRolePromptResolver implements RolePromptResolver {
  constructor(private readonly overrides?: SkillOverrideSet) {}

  resolve(role: SkillRole, tier: ComplexityTier): string | null {
    return resolvePromptFromOverrides(role, tier, this.overrides);
  }
}

export const buildSkillOverrides = (orchrc: ResolvedOrchrConfig): SkillOverrideSet => ({
  tdd:
    "content" in orchrc.skills.tdd
      ? orchrc.skills.tdd.content
      : "disabled" in orchrc.skills.tdd
        ? null
        : undefined,
  review:
    "content" in orchrc.skills.review
      ? orchrc.skills.review.content
      : "disabled" in orchrc.skills.review
        ? null
        : undefined,
  verify:
    "content" in orchrc.skills.verify
      ? orchrc.skills.verify.content
      : "disabled" in orchrc.skills.verify
        ? null
        : undefined,
  plan:
    "content" in orchrc.skills.plan
      ? orchrc.skills.plan.content
      : "disabled" in orchrc.skills.plan
        ? null
        : undefined,
  gap:
    "content" in orchrc.skills.gap
      ? orchrc.skills.gap.content
      : "disabled" in orchrc.skills.gap
        ? null
        : undefined,
});

export const loadTieredSkills = (tier: ComplexityTier, orchrc: ResolvedOrchrConfig): SkillSet => {
  const overrides = buildSkillOverrides(orchrc);

  return {
    tdd: resolvePromptFromOverrides("tdd", tier, overrides),
    plan: resolvePromptFromOverrides("plan", tier, overrides),
    review: resolvePromptFromOverrides("review", tier, overrides),
    gap: resolvePromptFromOverrides("gap", tier, overrides),
    verify: resolvePromptFromOverrides("verify", tier, overrides),
    completeness: null,
  };
};
