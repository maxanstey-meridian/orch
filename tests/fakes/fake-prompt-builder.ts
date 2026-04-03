import { PromptBuilder } from "#application/ports/prompt-builder.port.js";
import type { FinalPass } from "#application/ports/prompt-builder.port.js";

export const DIRECT_PROMPT_SENTINEL = "[DIRECT]";
export const DIRECT_TEST_PASS_PROMPT_SENTINEL = "[DIRECT_TEST_PASS]";

export class PassthroughPromptBuilder extends PromptBuilder {
  /** Override in tests to return custom final passes. */
  finalPassesOverride: readonly FinalPass[] = [];

  plan(sliceContent: string, sliceNumber: number): string {
    return `[PLAN:${sliceNumber}] ${sliceContent}`;
  }

  tdd(sliceContent: string, fixInstructions?: string, sliceNumber?: number): string {
    return `[TDD:${sliceNumber ?? "?"}] ${sliceContent}${fixInstructions ? ` FIX: ${fixInstructions}` : ""}`;
  }

  tddExecute(planText: string, sliceNumber: number, firstSlice: boolean, operatorGuidance?: string): string {
    return `[EXEC:${sliceNumber}] ${planText}${operatorGuidance ? ` GUIDANCE: ${operatorGuidance}` : ""}`;
  }

  groupedExecute(groupName: string, groupContent: string, firstGroup: boolean, operatorGuidance?: string): string {
    return `[GROUP_EXEC:${groupName}] ${groupContent}${operatorGuidance ? ` GUIDANCE: ${operatorGuidance}` : ""}`;
  }

  groupedTestPass(groupName: string, groupContent: string): string {
    return `[GROUP_TEST_PASS:${groupName}] ${groupContent}`;
  }

  directExecute(requestContent: string): string {
    return `${DIRECT_PROMPT_SENTINEL} ${requestContent}`;
  }

  directTestPass(requestContent: string): string {
    return `${DIRECT_TEST_PASS_PROMPT_SENTINEL} ${requestContent}`;
  }

  verify(baseSha: string, sliceNumber: number, fixSummary?: string): string {
    return `[VERIFY:${sliceNumber}] from=${baseSha}${fixSummary ? ` FIX: ${fixSummary}` : ""}`;
  }

  groupedVerify(baseSha: string, groupName: string, fixSummary?: string): string {
    return `[GROUP_VERIFY:${groupName}] from=${baseSha}${fixSummary ? ` FIX: ${fixSummary}` : ""}`;
  }

  review(content: string, baseSha: string, priorFindings?: string): string {
    return `[REVIEW] from=${baseSha}${priorFindings ? ` PRIOR: ${priorFindings}` : ""}`;
  }

  completeness(sliceContent: string, baseSha: string, sliceNumber: number): string {
    return `[COMPLETENESS:${sliceNumber}] from=${baseSha}`;
  }

  groupedCompleteness(groupContent: string, baseSha: string, groupName: string): string {
    return `[GROUP_COMPLETENESS:${groupName}] from=${baseSha}`;
  }

  gap(groupContent: string, baseSha: string): string {
    return `[GAP] from=${baseSha}`;
  }

  commitSweep(groupName: string): string {
    return `[SWEEP] ${groupName}`;
  }

  finalPasses(_baseSha: string): readonly FinalPass[] {
    return this.finalPassesOverride;
  }

  withBrief(prompt: string): string {
    return `[BRIEF] ${prompt}`;
  }

  rulesReminder(role: "tdd" | "review"): string {
    return `[RULES:${role}]`;
  }
}
