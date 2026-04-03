import { describe, it, expect } from "vitest";
import {
  PromptBuilder,
  type FinalPass,
} from "#application/ports/prompt-builder.port.js";

class MockPromptBuilder extends PromptBuilder {
  plan(sliceContent: string, sliceNumber: number): string {
    return `plan:${sliceContent}:${sliceNumber}`;
  }
  tdd(
    sliceContent: string,
    fixInstructions?: string,
    sliceNumber?: number,
  ): string {
    return `tdd:${sliceContent}:${fixInstructions ?? "none"}:${sliceNumber ?? "none"}`;
  }
  tddExecute(
    planText: string,
    sliceNumber: number,
    firstSlice: boolean,
    operatorGuidance?: string,
  ): string {
    return `tddExec:${planText}:${sliceNumber}:${firstSlice}:${operatorGuidance ?? "none"}`;
  }
  groupedExecute(
    groupName: string,
    groupContent: string,
    firstGroup: boolean,
    operatorGuidance?: string,
  ): string {
    return `groupExec:${groupName}:${groupContent}:${firstGroup}:${operatorGuidance ?? "none"}`;
  }
  groupedTestPass(groupName: string, groupContent: string): string {
    return `groupTest:${groupName}:${groupContent}`;
  }
  directExecute(requestContent: string): string {
    return `directExecute:${requestContent}`;
  }
  directTestPass(requestContent: string): string {
    return `directTestPass:${requestContent}`;
  }
  verify(baseSha: string, sliceNumber: number, fixSummary?: string): string {
    return `verify:${baseSha}:${sliceNumber}:${fixSummary ?? "none"}`;
  }
  groupedVerify(baseSha: string, groupName: string, fixSummary?: string): string {
    return `groupVerify:${baseSha}:${groupName}:${fixSummary ?? "none"}`;
  }
  review(content: string, baseSha: string, priorFindings?: string): string {
    return `review:${content}:${baseSha}:${priorFindings ?? "none"}`;
  }
  completeness(
    sliceContent: string,
    baseSha: string,
    sliceNumber: number,
  ): string {
    return `completeness:${sliceContent}:${baseSha}:${sliceNumber}`;
  }
  groupedCompleteness(groupContent: string, baseSha: string, groupName: string): string {
    return `groupCompleteness:${groupContent}:${baseSha}:${groupName}`;
  }
  gap(groupContent: string, baseSha: string): string {
    return `gap:${groupContent}:${baseSha}`;
  }
  commitSweep(groupName: string): string {
    return `commitSweep:${groupName}`;
  }
  finalPasses(baseSha: string): readonly FinalPass[] {
    return [{ name: "Type audit", prompt: `types:${baseSha}` }];
  }
  withBrief(prompt: string): string {
    return `brief:${prompt}`;
  }
  rulesReminder(role: "tdd" | "review"): string {
    return `rules:${role}`;
  }
}

describe("PromptBuilder", () => {
  it("MockPromptBuilder can be instantiated", () => {
    const builder = new MockPromptBuilder();
    expect(builder).toBeInstanceOf(PromptBuilder);
  });

  it("plan returns a string for sliceContent and sliceNumber", () => {
    const builder = new MockPromptBuilder();
    expect(builder.plan("slice1", 1)).toBe("plan:slice1:1");
  });

  it("tdd returns a string with no optional args", () => {
    const builder = new MockPromptBuilder();
    expect(builder.tdd("slice1")).toBe("tdd:slice1:none:none");
  });

  it("tdd returns a string with all optional args", () => {
    const builder = new MockPromptBuilder();
    expect(builder.tdd("slice1", "fix this", 3)).toBe("tdd:slice1:fix this:3");
  });

  it("tddExecute returns a string without guidance", () => {
    const builder = new MockPromptBuilder();
    expect(builder.tddExecute("plan text", 2, true)).toBe(
      "tddExec:plan text:2:true:none",
    );
  });

  it("tddExecute returns a string with guidance", () => {
    const builder = new MockPromptBuilder();
    expect(builder.tddExecute("plan text", 2, false, "do better")).toBe(
      "tddExec:plan text:2:false:do better",
    );
  });

  it("groupedExecute returns a string without guidance", () => {
    const builder = new MockPromptBuilder();
    expect(builder.groupedExecute("Core", "group text", true)).toBe(
      "groupExec:Core:group text:true:none",
    );
  });

  it("groupedExecute returns a string with guidance", () => {
    const builder = new MockPromptBuilder();
    expect(builder.groupedExecute("Core", "group text", false, "focus on tests")).toBe(
      "groupExec:Core:group text:false:focus on tests",
    );
  });

  it("groupedTestPass returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.groupedTestPass("Core", "group text")).toBe("groupTest:Core:group text");
  });

  it("directExecute returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.directExecute("request text")).toBe("directExecute:request text");
  });

  it("directTestPass returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.directTestPass("request text")).toBe("directTestPass:request text");
  });

  it("review returns a string without priorFindings", () => {
    const builder = new MockPromptBuilder();
    expect(builder.review("content", "abc123")).toBe(
      "review:content:abc123:none",
    );
  });

  it("verify returns a string without fix summary", () => {
    const builder = new MockPromptBuilder();
    expect(builder.verify("abc123", 2)).toBe("verify:abc123:2:none");
  });

  it("verify returns a string with fix summary", () => {
    const builder = new MockPromptBuilder();
    expect(builder.verify("abc123", 2, "fixed the issue")).toBe(
      "verify:abc123:2:fixed the issue",
    );
  });

  it("groupedVerify returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.groupedVerify("abc123", "Core", "fixed the issue")).toBe(
      "groupVerify:abc123:Core:fixed the issue",
    );
  });

  it("review returns a string with priorFindings", () => {
    const builder = new MockPromptBuilder();
    expect(builder.review("content", "abc123", "prior")).toBe(
      "review:content:abc123:prior",
    );
  });

  it("completeness returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.completeness("slice1", "abc123", 1)).toBe(
      "completeness:slice1:abc123:1",
    );
  });

  it("groupedCompleteness returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.groupedCompleteness("group text", "abc123", "Core")).toBe(
      "groupCompleteness:group text:abc123:Core",
    );
  });

  it("gap returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.gap("group1", "abc123")).toBe("gap:group1:abc123");
  });

  it("commitSweep returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.commitSweep("Domain")).toBe("commitSweep:Domain");
  });

  it("finalPasses returns readonly FinalPass[] with name and prompt", () => {
    const builder = new MockPromptBuilder();
    const passes = builder.finalPasses("abc123");
    expect(passes).toHaveLength(1);
    expect(typeof passes[0].name).toBe("string");
    expect(typeof passes[0].prompt).toBe("string");
    expect(passes[0].name).toBe("Type audit");
    expect(passes[0].prompt).toBe("types:abc123");
  });

  it("withBrief returns a string", () => {
    const builder = new MockPromptBuilder();
    expect(builder.withBrief("some prompt")).toBe("brief:some prompt");
  });

  it("rulesReminder returns a string for tdd and review roles", () => {
    const builder = new MockPromptBuilder();
    expect(builder.rulesReminder("tdd")).toBe("rules:tdd");
    expect(builder.rulesReminder("review")).toBe("rules:review");
  });

  it("FinalPass type has name and prompt string fields", () => {
    const pass: FinalPass = { name: "Type audit", prompt: "Check types..." };
    expect(typeof pass.name).toBe("string");
    expect(typeof pass.prompt).toBe("string");
  });
});
