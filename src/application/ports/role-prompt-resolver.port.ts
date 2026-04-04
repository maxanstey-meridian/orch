import type { SkillRole } from "#domain/config.js";
import type { ComplexityTier } from "#domain/triage.js";

export abstract class RolePromptResolver {
  abstract resolve(role: SkillRole, tier: ComplexityTier): string | null;
}
