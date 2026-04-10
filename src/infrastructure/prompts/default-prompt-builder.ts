import { PromptBuilder, type FinalPass } from "#application/ports/prompt-builder.port.js";
import {
  withBrief as applyBrief,
  buildCommitSweepPrompt,
  buildCompletenessPrompt,
  buildDirectCompletenessPrompt,
  buildDirectExecutePrompt,
  buildDirectFinalPasses,
  buildDirectGapPrompt,
  buildDirectReviewPrompt,
  buildDirectTestPassPrompt,
  buildDirectVerifyPrompt,
  buildFinalPasses,
  buildGapPrompt,
  buildGroupedCompletenessPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildTddPrompt,
  buildVerifyPrompt,
} from "#infrastructure/plan/prompts.js";

const buildRulesReminder = (baseRules: string, extraRules?: string): string =>
  !extraRules
    ? baseRules
    : `${baseRules}\n\n[PROJECT] Additional rules from .orchrc.json:\n${extraRules}`;

const TDD_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. RUN TESTS WITH BASH. Use your Bash tool to execute tests. Read the actual output. Do not narrate "RED confirmed" or "GREEN" without executing. No exceptions.
2. COMMIT WHEN DONE. After all behaviours are GREEN, run the full test suite, then git add + git commit. Uncommitted work is invisible to the review agent.
3. STAY IN SCOPE. Only modify files relevant to your current task. Do not touch, revert, or "clean up" unrelated files. Use git add with specific filenames, never git add . or git add -A.
4. USE CLASSES FOR STATEFUL SERVICES. Do not create standalone functions with deps bags or parameter objects. If something holds state or coordinates multiple operations, make it a class with constructor injection. Methods access dependencies via \`this\`, not via passed-in params objects.
5. WRITE DEFENSIVE TESTS. For every feature, verify: if someone deleted the key line that makes it work, would a test fail? If not, add one. Test observable state changes directly — not mock call arguments. A test that passes whether the feature works or not is worse than no test.`;

const REVIEW_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. ONLY REVIEW THE DIFF. Review files changed in the diff. Ignore unrelated uncommitted changes in the working tree — they belong to the operator.
2. DO NOT SUGGEST REVERTING unrelated files (skill files, config, HUD changes) that weren't part of the slice.
3. If the diff is empty and HEAD hasn't moved, respond with REVIEW_CLEAN. Do not claim work is missing if it was committed in prior commits.`;

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
    return applyBrief(buildPlanPrompt(sliceContent, this.planContent, sliceNumber), this.brief);
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
    return firstSlice ? applyBrief(raw, this.brief) : raw;
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
    return firstGroup ? applyBrief(raw, this.brief) : raw;
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
    return applyBrief(buildDirectExecutePrompt(requestContent), this.brief);
  }

  directTestPass(requestContent: string): string {
    return applyBrief(buildDirectTestPassPrompt(requestContent), this.brief);
  }

  directVerify(baseSha: string, requestContent: string, fixSummary?: string): string {
    return applyBrief(buildDirectVerifyPrompt(baseSha, requestContent, fixSummary), this.brief);
  }

  directReview(requestContent: string, baseSha: string, followUp = false): string {
    return buildDirectReviewPrompt(requestContent, baseSha, followUp);
  }

  directCompleteness(requestContent: string, baseSha: string): string {
    return applyBrief(buildDirectCompletenessPrompt(requestContent, baseSha), this.brief);
  }

  directGap(requestContent: string): string {
    return applyBrief(buildDirectGapPrompt(requestContent), this.brief);
  }

  verify(baseSha: string, sliceNumber: number, fixSummary?: string): string {
    return applyBrief(buildVerifyPrompt(baseSha, `Slice ${sliceNumber}`, fixSummary), this.brief);
  }

  groupedVerify(baseSha: string, groupName: string, fixSummary?: string): string {
    return applyBrief(buildVerifyPrompt(baseSha, `Group ${groupName}`, fixSummary), this.brief);
  }

  review(content: string, baseSha: string, followUp = false): string {
    return buildReviewPrompt(content, baseSha, followUp);
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

  directFinalPasses(baseSha: string, requestContent: string): readonly FinalPass[] {
    return buildDirectFinalPasses(baseSha, requestContent);
  }

  withBrief(prompt: string): string {
    return applyBrief(prompt, this.brief);
  }

  rulesReminder(role: "tdd" | "review"): string {
    return role === "tdd"
      ? buildRulesReminder(TDD_RULES_REMINDER, this.tddRules)
      : buildRulesReminder(REVIEW_RULES_REMINDER, this.reviewRules);
  }
}
