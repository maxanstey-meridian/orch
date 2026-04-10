import {
  buildOrchrSummary,
  loadAndResolveOrchrConfig,
  loadOrchrConfig,
  orchrcSchema,
  resolveOrchrConfig,
  resolveSkillValue,
  type OrchrConfig,
  type ResolvedOrchrConfig,
  type ResolvedSkill,
} from "./orchrc.js";

export {
  buildOrchrSummary,
  loadAndResolveOrchrConfig,
  loadOrchrConfig,
  orchrcSchema,
  resolveOrchrConfig,
  resolveSkillValue,
};

export type { OrchrConfig, ResolvedOrchrConfig, ResolvedSkill };

export class OrchrConfigLoader {
  constructor(private readonly cwd: string) {}

  load(): OrchrConfig {
    return loadOrchrConfig(this.cwd);
  }

  resolve(raw: OrchrConfig): ResolvedOrchrConfig {
    return resolveOrchrConfig(raw, this.cwd);
  }

  loadResolved(): ResolvedOrchrConfig {
    return loadAndResolveOrchrConfig(this.cwd);
  }

  buildSummary(config: ResolvedOrchrConfig): string | undefined {
    return buildOrchrSummary(config);
  }
}
