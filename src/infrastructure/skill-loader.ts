import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillSet } from "#domain/config.js";
import type { ComplexityTier } from "#domain/triage.js";
import type { ResolvedOrchrConfig } from "./config/orchrc.js";
import { resolveSkillValue } from "./config/orchrc.js";

export const loadTieredSkills = (tier: ComplexityTier, orchrc: ResolvedOrchrConfig): SkillSet => {
  const skillsDir = resolve(import.meta.dirname, "..", "..", "skills");
  const tierDir = resolve(skillsDir, tier);

  const builtInTdd = readFileSync(resolve(tierDir, "build.md"), "utf-8");
  const builtInPlan = readFileSync(resolve(tierDir, "plan.md"), "utf-8");
  const builtInReview = readFileSync(resolve(tierDir, "review.md"), "utf-8");
  const builtInGap = readFileSync(resolve(tierDir, "gap.md"), "utf-8");
  const builtInVerify = readFileSync(resolve(skillsDir, "verify.md"), "utf-8");

  const review = resolveSkillValue(orchrc.skills.review, builtInReview);

  return {
    tdd: resolveSkillValue(orchrc.skills.tdd, builtInTdd),
    plan: resolveSkillValue(orchrc.skills.plan, builtInPlan),
    review,
    gap: resolveSkillValue(orchrc.skills.gap, builtInGap),
    verify: resolveSkillValue(orchrc.skills.verify, builtInVerify),
    // Completeness prompts come from the per-run prompt builder. Reusing the
    // review system prompt changes the required sentinel contract.
    completeness: null,
  };
};
