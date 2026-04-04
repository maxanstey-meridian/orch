import type { ResolvedAgentConfig } from "./agent-config.js";
import type { AgentRole } from "./agent-types.js";
import type { ComplexityTier } from "./triage.js";

export type Provider = "claude" | "codex";
export type ExecutionMode = "direct" | "grouped" | "sliced";
export type ExecutionPreference = "auto" | "quick" | "grouped" | "long";

export const DEFAULT_EXECUTION_PREFERENCE: ExecutionPreference = "auto";

export type SkillRole = "tdd" | "review" | "verify" | "plan" | "gap" | "completeness";
export type SkillSet = Readonly<Record<SkillRole, string | null>>;

export type OrchestratorConfig = {
  readonly cwd: string;
  readonly planPath: string;
  readonly planContent: string;
  readonly brief: string;
  readonly executionMode: ExecutionMode;
  readonly executionPreference: ExecutionPreference;
  readonly auto: boolean;
  readonly reviewThreshold: number;
  readonly maxReviewCycles: number;
  readonly stateFile: string;
  readonly logPath: string | null;
  readonly tier: ComplexityTier;
  readonly skills: SkillSet;
  readonly maxReplans: number;
  readonly defaultProvider: Provider;
  readonly agentConfig: Record<AgentRole, ResolvedAgentConfig>;
  readonly tddRules?: string;
  readonly reviewRules?: string;
};
