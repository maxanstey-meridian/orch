import { PromptBuilder, type FinalPass } from "../application/ports/prompt-builder.port.js";
import {
  withBrief as _withBrief,
  buildPlanPrompt,
  buildTddPrompt,
  buildReviewPrompt,
  buildCompletenessPrompt,
  buildCommitSweepPrompt,
  buildGapPrompt,
  buildFinalPasses,
} from "../plan/prompts.js";
import {
  TDD_RULES_REMINDER,
  REVIEW_RULES_REMINDER,
  buildRulesReminder,
} from "../agent/agent-factory.js";

export class DefaultPromptBuilder extends PromptBuilder {
  constructor(
    private readonly brief: string,
    private readonly planContent: string,
    private readonly tddRules?: string,
    private readonly reviewRules?: string,
  ) {
    super();
  }

  plan(sliceContent: string, sliceNumber: number): string {
    return _withBrief(buildPlanPrompt(sliceContent, this.planContent, sliceNumber), this.brief);
  }

  tdd(sliceContent: string, fixInstructions?: string, sliceNumber?: number): string {
    return buildTddPrompt(sliceContent, fixInstructions, this.planContent, sliceNumber);
  }

  tddExecute(planText: string, sliceNumber: number, firstSlice: boolean, operatorGuidance?: string): string {
    const firstSliceContext = firstSlice
      ? `## Full Plan Context\nYou are implementing Slice ${sliceNumber}. Here is the full plan — do NOT implement other slices.\n\n${this.planContent}\n\n---\n\n`
      : "";
    const raw = operatorGuidance
      ? `${firstSliceContext}Operator guidance: ${operatorGuidance}\n\nExecute this plan for Slice ${sliceNumber}:\n\n${planText}`
      : `${firstSliceContext}Execute this plan for Slice ${sliceNumber}:\n\n${planText}`;
    return firstSlice ? _withBrief(raw, this.brief) : raw;
  }

  review(content: string, baseSha: string, priorFindings?: string): string {
    return buildReviewPrompt(content, baseSha, priorFindings);
  }

  completeness(sliceContent: string, baseSha: string, sliceNumber: number): string {
    return buildCompletenessPrompt(sliceContent, baseSha, this.planContent, sliceNumber);
  }

  gap(groupContent: string, baseSha: string): string {
    return buildGapPrompt(groupContent, baseSha);
  }

  commitSweep(groupName: string): string {
    return buildCommitSweepPrompt(groupName);
  }

  finalPasses(baseSha: string): readonly FinalPass[] {
    return buildFinalPasses(baseSha, this.planContent);
  }

  withBrief(prompt: string): string {
    return _withBrief(prompt, this.brief);
  }

  rulesReminder(role: "tdd" | "review"): string {
    return role === "tdd"
      ? buildRulesReminder(TDD_RULES_REMINDER, this.tddRules)
      : buildRulesReminder(REVIEW_RULES_REMINDER, this.reviewRules);
  }
}
