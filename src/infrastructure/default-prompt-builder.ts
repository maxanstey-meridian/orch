import { PromptBuilder, type FinalPass } from "#application/ports/prompt-builder.port.js";
import {
  TDD_RULES_REMINDER,
  REVIEW_RULES_REMINDER,
  buildRulesReminder,
} from "./claude/claude-agent-factory.js";
import {
  withBrief as _withBrief,
  buildPlanPrompt,
  buildTddPrompt,
  buildDirectExecutePrompt,
  buildDirectTestPassPrompt,
  buildVerifyPrompt,
  buildReviewPrompt,
  buildCompletenessPrompt,
  buildGroupedCompletenessPrompt,
  buildCommitSweepPrompt,
  buildGapPrompt,
  buildFinalPasses,
} from "./plan/prompts.js";

export class DefaultPromptBuilder extends PromptBuilder {
  constructor(
    private readonly brief: string,
    private readonly planContent: string,
    private readonly tddRules?: string,
    private readonly reviewRules?: string,
  ) {
    super();
  }

  private buildSliceTddPrompt(
    sliceContent: string,
    fixInstructions?: string,
    sliceNumber?: number,
  ): string {
    return buildTddPrompt(sliceContent, fixInstructions, this.planContent, sliceNumber);
  }

  private buildSliceCompletenessPrompt(
    sliceContent: string,
    baseSha: string,
    sliceNumber: number,
  ): string {
    return buildCompletenessPrompt(sliceContent, baseSha, this.planContent, sliceNumber);
  }

  plan(sliceContent: string, sliceNumber: number): string {
    return _withBrief(buildPlanPrompt(sliceContent, this.planContent, sliceNumber), this.brief);
  }

  tdd(sliceContent: string, fixInstructions?: string, sliceNumber?: number): string {
    return this.buildSliceTddPrompt(sliceContent, fixInstructions, sliceNumber);
  }

  tddExecute(
    planText: string,
    sliceNumber: number,
    firstSlice: boolean,
    operatorGuidance?: string,
  ): string {
    const firstSliceContext = firstSlice
      ? `## Full Plan Context\nYou are implementing Slice ${sliceNumber}. Here is the full plan — do NOT implement other slices.\n\n${this.planContent}\n\n---\n\n`
      : "";
    const raw = operatorGuidance
      ? `${firstSliceContext}Operator guidance: ${operatorGuidance}\n\nExecute this plan for Slice ${sliceNumber}:\n\n${planText}`
      : `${firstSliceContext}Execute this plan for Slice ${sliceNumber}:\n\n${planText}`;
    return firstSlice ? _withBrief(raw, this.brief) : raw;
  }

  groupedExecute(
    groupName: string,
    groupContent: string,
    firstGroup: boolean,
    operatorGuidance?: string,
  ): string {
    const firstGroupContext = firstGroup
      ? `## Full Plan Context\nYou are implementing Group ${groupName}. Here is the full plan — do NOT implement other groups.\n\n${this.planContent}\n\n---\n\n`
      : "";
    const raw = operatorGuidance
      ? `${firstGroupContext}Operator guidance: ${operatorGuidance}\n\nExecute this plan for Group ${groupName} as one bounded increment:\n\n${groupContent}`
      : `${firstGroupContext}Execute this plan for Group ${groupName} as one bounded increment:\n\n${groupContent}`;
    return firstGroup ? _withBrief(raw, this.brief) : raw;
  }

  groupedTestPass(groupName: string, groupContent: string): string {
    return `Run the mandatory test pass for Group ${groupName}.

Review the whole grouped increment, run the relevant tests, and explain:
- changed behavior
- regression risks
- tests added or updated
- why those tests are useful

Do not invent future work. Keep the report scoped to this group.

## Group Content
${groupContent}`;
  }

  directExecute(requestContent: string): string {
    return _withBrief(buildDirectExecutePrompt(requestContent), this.brief);
  }

  directTestPass(requestContent: string): string {
    return _withBrief(buildDirectTestPassPrompt(requestContent), this.brief);
  }

  verify(baseSha: string, sliceNumber: number, fixSummary?: string): string {
    return _withBrief(buildVerifyPrompt(baseSha, `Slice ${sliceNumber}`, fixSummary), this.brief);
  }

  groupedVerify(baseSha: string, groupName: string, fixSummary?: string): string {
    return _withBrief(buildVerifyPrompt(baseSha, `Group ${groupName}`, fixSummary), this.brief);
  }

  review(content: string, baseSha: string, priorFindings?: string): string {
    return buildReviewPrompt(content, baseSha, priorFindings);
  }

  completeness(sliceContent: string, baseSha: string, sliceNumber: number): string {
    return this.buildSliceCompletenessPrompt(sliceContent, baseSha, sliceNumber);
  }

  groupedCompleteness(groupContent: string, baseSha: string, groupName: string): string {
    return buildGroupedCompletenessPrompt(groupContent, baseSha, this.planContent, groupName);
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
