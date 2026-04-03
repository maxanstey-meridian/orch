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
  abstract groupedExecute(
    groupName: string,
    groupContent: string,
    firstGroup: boolean,
    operatorGuidance?: string,
  ): string;
  abstract groupedTestPass(groupName: string, groupContent: string): string;
  abstract directExecute(requestContent: string): string;
  abstract directTestPass(requestContent: string): string;
  abstract verify(baseSha: string, sliceNumber: number, fixSummary?: string): string;
  abstract groupedVerify(baseSha: string, groupName: string, fixSummary?: string): string;
  abstract review(content: string, baseSha: string, priorFindings?: string): string;
  abstract completeness(sliceContent: string, baseSha: string, sliceNumber: number): string;
  abstract groupedCompleteness(groupContent: string, baseSha: string, groupName: string): string;
  abstract gap(groupContent: string, baseSha: string): string;
  abstract commitSweep(groupName: string): string;
  abstract finalPasses(baseSha: string): readonly FinalPass[];
  abstract withBrief(prompt: string): string;
  abstract rulesReminder(role: "tdd" | "review"): string;
}
