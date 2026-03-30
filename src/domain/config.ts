export type Provider = "claude" | "codex";

export type OrchestratorConfig = {
  readonly cwd: string;
  readonly planPath: string;
  readonly planContent: string;
  readonly brief: string;
  readonly noInteraction: boolean;
  readonly auto: boolean;
  readonly reviewThreshold: number;
  readonly maxReviewCycles: number;
  readonly stateFile: string;
  readonly tddSkill: string | null;
  readonly reviewSkill: string | null;
  readonly verifySkill: string | null;
  readonly gapDisabled: boolean;
  readonly planDisabled: boolean;
  readonly maxReplans: number;
  readonly provider: Provider;
  readonly tddRules?: string;
  readonly reviewRules?: string;
};
