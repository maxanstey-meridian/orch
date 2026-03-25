import { describe, it, expect } from "vitest";
import { detectQuestion } from "./question-detector.js";

describe("detectQuestion", () => {
  it("returns false for empty input", () => {
    expect(detectQuestion("")).toBe(false);
  });

  it("detects trailing question mark", () => {
    expect(detectQuestion("Is this correct?")).toBe(true);
  });

  it("detects question mark followed by whitespace and code formatting", () => {
    expect(detectQuestion("Is this correct?\n```\n\n")).toBe(true);
    expect(detectQuestion("Does this work?  \n")).toBe(true);
    expect(detectQuestion("Ready?`")).toBe(true);
  });

  it("detects conversational question patterns", () => {
    expect(detectQuestion("I finished the refactor. What do you think")).toBe(true);
    expect(detectQuestion("Should I proceed with the migration")).toBe(true);
    expect(detectQuestion("Want me to fix that too")).toBe(true);
    expect(detectQuestion("Let me know if you have any preferences")).toBe(true);
    expect(detectQuestion("Before I proceed, here is the plan.")).toBe(true);
    expect(detectQuestion("Any thoughts on this approach")).toBe(true);
    expect(detectQuestion("How would you like me to handle this")).toBe(true);
    expect(detectQuestion("Any feedback on the above")).toBe(true);
  });

  it("ignores questions outside the trailing 500 characters", () => {
    const earlyQuestion = "Should I proceed with this?\n";
    const substantiveWork = "x".repeat(600) + "\nDone.";
    expect(detectQuestion(earlyQuestion + substantiveWork)).toBe(false);
  });

  it("returns false for definitive statements", () => {
    expect(detectQuestion("I have completed the task.")).toBe(false);
    expect(detectQuestion("All tests pass. Ready for review.")).toBe(false);
    expect(detectQuestion("Done. No issues found.")).toBe(false);
  });

  it("matches patterns case-insensitively", () => {
    expect(detectQuestion("WHAT DO YOU THINK")).toBe(true);
    expect(detectQuestion("Should We continue")).toBe(true);
    expect(detectQuestion("LET ME KNOW")).toBe(true);
  });

  it("ignores pattern early in tail when followed by substantive work", () => {
    const output = "Should I do this?\nI did it. Here is the result. All done.";
    expect(detectQuestion(output)).toBe(false);
  });

  it("does not flag ternary operator question mark inside trailing code block", () => {
    const output = "Here is the fix.\n```\nconst x = foo == bar ? a : b\n```";
    expect(detectQuestion(output)).toBe(false);
  });
});
