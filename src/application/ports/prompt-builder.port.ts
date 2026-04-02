export type FinalPass = { readonly name: string; readonly prompt: string };

export abstract class PromptBuilder {
  abstract plan(sliceContent: string, sliceNumber: number): string;
  abstract tdd(sliceContent: string, fixInstructions?: string, sliceNumber?: number): string;
  abstract tddExecute(
    planText: string,
    sliceNumber: number,
    firstSlice: boolean,
    operatorGuidance?: string,
  ): string;
  abstract verify(baseSha: string, sliceNumber: number, fixSummary?: string): string;
  abstract review(content: string, baseSha: string, priorFindings?: string): string;
  abstract completeness(sliceContent: string, baseSha: string, sliceNumber: number): string;
  abstract gap(groupContent: string, baseSha: string): string;
  abstract commitSweep(groupName: string): string;
  abstract finalPasses(baseSha: string): readonly FinalPass[];
  abstract withBrief(prompt: string): string;
  abstract rulesReminder(role: "tdd" | "review"): string;
}
