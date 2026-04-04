import { RolePromptResolver } from "#application/ports/role-prompt-resolver.port.js";
import type { SkillRole } from "#domain/config.js";
import type { ComplexityTier } from "#domain/triage.js";

export class FakeRolePromptResolver extends RolePromptResolver {
  setPrompt(
    key: SkillRole | `${SkillRole}:${ComplexityTier}`,
    value: string | null,
  ): void {
    this.prompts[key] = value;
  }

  resolve(role: SkillRole, tier: ComplexityTier): string | null {
    return this.prompts[`${role}:${tier}`] ?? this.prompts[role] ?? null;
  }

  constructor(
    private readonly prompts: Partial<
      Record<SkillRole | `${SkillRole}:${ComplexityTier}`, string | null>
    > = {},
  ) {
    super();
  }
}
