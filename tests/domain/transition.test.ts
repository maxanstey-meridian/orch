import { describe, it, expect } from "vitest";
import type { Phase } from "#domain/phase.js";
import { transition, canSkip, isAlreadyImplemented } from "#domain/transition.js";

describe("Phase union", () => {
  it("each variant is constructable with correct kind and fields", () => {
    const idle: Phase = { kind: "Idle" };
    expect(idle.kind).toBe("Idle");

    const planning: Phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };
    expect(planning.kind).toBe("Planning");

    const gated: Phase = { kind: "Gated", sliceNumber: 1, planText: "plan", attempt: 1 };
    expect(gated.kind).toBe("Gated");

    const executing: Phase = { kind: "Executing", sliceNumber: 1, planText: "plan" };
    expect(executing.kind).toBe("Executing");

    const executingNull: Phase = { kind: "Executing", sliceNumber: 1, planText: null };
    expect(executingNull.kind).toBe("Executing");

    const verifying: Phase = { kind: "Verifying", sliceNumber: 1 };
    expect(verifying.kind).toBe("Verifying");

    const completeness: Phase = { kind: "CompletenessCheck", sliceNumber: 1 };
    expect(completeness.kind).toBe("CompletenessCheck");

    const reviewing: Phase = { kind: "Reviewing", sliceNumber: 1, cycle: 1 };
    expect(reviewing.kind).toBe("Reviewing");

    const gap: Phase = { kind: "GapAnalysis", groupName: "Domain" };
    expect(gap.kind).toBe("GapAnalysis");

    const finalPasses: Phase = { kind: "FinalPasses", passIndex: 0 };
    expect(finalPasses.kind).toBe("FinalPasses");

    const complete: Phase = { kind: "Complete" };
    expect(complete.kind).toBe("Complete");
  });
});

describe("transition", () => {
  it("Idle + StartPlanning → Planning", () => {
    const result = transition({ kind: "Idle" }, { kind: "StartPlanning", sliceNumber: 1 });
    expect(result).toEqual({ kind: "Planning", sliceNumber: 1, attempt: 1 });
  });

  it("Planning + PlanReady → Gated", () => {
    const result = transition(
      { kind: "Planning", sliceNumber: 1, attempt: 1 },
      { kind: "PlanReady", planText: "the plan" },
    );
    expect(result).toEqual({ kind: "Gated", sliceNumber: 1, planText: "the plan", attempt: 1 });
  });

  it("Gated + PlanAccepted → Executing", () => {
    const result = transition(
      { kind: "Gated", sliceNumber: 1, planText: "the plan", attempt: 1 },
      { kind: "PlanAccepted" },
    );
    expect(result).toEqual({ kind: "Executing", sliceNumber: 1, planText: "the plan" });
  });

  it("Gated with attempt=3 + PlanAccepted → Executing after multi-replan", () => {
    const result = transition(
      { kind: "Gated", sliceNumber: 1, planText: "revised plan", attempt: 3 },
      { kind: "PlanAccepted" },
    );
    expect(result).toEqual({ kind: "Executing", sliceNumber: 1, planText: "revised plan" });
  });

  it("Gated + PlanRejected → Planning with attempt+1", () => {
    const result = transition(
      { kind: "Gated", sliceNumber: 1, planText: "the plan", attempt: 1 },
      { kind: "PlanRejected" },
    );
    expect(result).toEqual({ kind: "Planning", sliceNumber: 1, attempt: 2 });
  });

  it("Executing + ExecutionDone → CompletenessCheck", () => {
    const result = transition(
      { kind: "Executing", sliceNumber: 1, planText: "plan" },
      { kind: "ExecutionDone" },
    );
    expect(result).toEqual({ kind: "CompletenessCheck", sliceNumber: 1 });
  });

  it("Verifying + VerifyPassed → Reviewing", () => {
    const result = transition(
      { kind: "Verifying", sliceNumber: 1 },
      { kind: "VerifyPassed" },
    );
    expect(result).toEqual({ kind: "Reviewing", sliceNumber: 1, cycle: 1 });
  });

  it("Verifying + VerifyFailed → Executing with null planText", () => {
    const result = transition(
      { kind: "Verifying", sliceNumber: 1 },
      { kind: "VerifyFailed" },
    );
    expect(result).toEqual({ kind: "Executing", sliceNumber: 1, planText: null });
  });

  it("CompletenessCheck + CompletenessOk → Verifying", () => {
    const result = transition(
      { kind: "CompletenessCheck", sliceNumber: 1 },
      { kind: "CompletenessOk" },
    );
    expect(result).toEqual({ kind: "Verifying", sliceNumber: 1 });
  });

  it("CompletenessCheck + CompletenessIssues → Executing", () => {
    const result = transition(
      { kind: "CompletenessCheck", sliceNumber: 1 },
      { kind: "CompletenessIssues" },
    );
    expect(result).toEqual({ kind: "Executing", sliceNumber: 1, planText: null });
  });

  it("Reviewing + ReviewIssues → Reviewing with cycle+1", () => {
    const result = transition(
      { kind: "Reviewing", sliceNumber: 1, cycle: 1 },
      { kind: "ReviewIssues" },
    );
    expect(result).toEqual({ kind: "Reviewing", sliceNumber: 1, cycle: 2 });
  });

  it("Reviewing + ReviewClean → Idle", () => {
    const result = transition(
      { kind: "Reviewing", sliceNumber: 1, cycle: 1 },
      { kind: "ReviewClean" },
    );
    expect(result).toEqual({ kind: "Idle" });
  });

  it("Reviewing + SliceComplete → Idle", () => {
    const result = transition(
      { kind: "Reviewing", sliceNumber: 1, cycle: 1 },
      { kind: "SliceComplete" },
    );
    expect(result).toEqual({ kind: "Idle" });
  });

  it("Idle + StartGap → GapAnalysis", () => {
    const result = transition(
      { kind: "Idle" },
      { kind: "StartGap", groupName: "Domain" },
    );
    expect(result).toEqual({ kind: "GapAnalysis", groupName: "Domain" });
  });

  it("GapAnalysis + GapDone → Idle", () => {
    const result = transition(
      { kind: "GapAnalysis", groupName: "Domain" },
      { kind: "GapDone" },
    );
    expect(result).toEqual({ kind: "Idle" });
  });

  it("Idle + StartFinalPasses → FinalPasses", () => {
    const result = transition(
      { kind: "Idle" },
      { kind: "StartFinalPasses" },
    );
    expect(result).toEqual({ kind: "FinalPasses", passIndex: 0 });
  });

  it("FinalPasses + AllPassesDone → Complete", () => {
    const result = transition(
      { kind: "FinalPasses", passIndex: 2 },
      { kind: "AllPassesDone" },
    );
    expect(result).toEqual({ kind: "Complete" });
  });

  it("Idle + ExecutionDone throws", () => {
    expect(() => transition({ kind: "Idle" }, { kind: "ExecutionDone" }))
      .toThrow("Illegal transition: Idle + ExecutionDone");
  });

  it("Idle + ReviewIssues throws", () => {
    expect(() => transition({ kind: "Idle" }, { kind: "ReviewIssues" }))
      .toThrow("Illegal transition: Idle + ReviewIssues");
  });

  it("Planning + StartGap throws", () => {
    expect(() => transition(
      { kind: "Planning", sliceNumber: 1, attempt: 1 },
      { kind: "StartGap", groupName: "X" },
    )).toThrow("Illegal transition: Planning + StartGap");
  });

  it("Executing + AllPassesDone throws", () => {
    expect(() => transition(
      { kind: "Executing", sliceNumber: 1, planText: null },
      { kind: "AllPassesDone" },
    )).toThrow("Illegal transition: Executing + AllPassesDone");
  });

  it("Reviewing + StartPlanning throws", () => {
    expect(() => transition(
      { kind: "Reviewing", sliceNumber: 1, cycle: 1 },
      { kind: "StartPlanning", sliceNumber: 2 },
    )).toThrow("Illegal transition: Reviewing + StartPlanning");
  });

  it("Complete + any event throws", () => {
    expect(() => transition(
      { kind: "Complete" },
      { kind: "StartPlanning", sliceNumber: 1 },
    )).toThrow("Illegal transition: Complete + StartPlanning");
  });
});

describe("canSkip", () => {
  const baseConfig = { skills: { plan: "test" as string | null, verify: "test" as string | null, gap: "test" as string | null } };

  it("returns true for Planning when plan skill is null", () => {
    expect(canSkip({ kind: "Planning", sliceNumber: 1, attempt: 1 }, { skills: { ...baseConfig.skills, plan: null } })).toBe(true);
  });

  it("returns true for Verifying when verify skill is null", () => {
    expect(canSkip({ kind: "Verifying", sliceNumber: 1 }, { skills: { ...baseConfig.skills, verify: null } })).toBe(true);
  });

  it("returns true for GapAnalysis when gap skill is null", () => {
    expect(canSkip({ kind: "GapAnalysis", groupName: "X" }, { skills: { ...baseConfig.skills, gap: null } })).toBe(true);
  });

  it("returns false for Planning when plan skill is set", () => {
    expect(canSkip({ kind: "Planning", sliceNumber: 1, attempt: 1 }, baseConfig)).toBe(false);
  });

  it("returns false for non-skippable phases", () => {
    expect(canSkip({ kind: "Executing", sliceNumber: 1, planText: null }, baseConfig)).toBe(false);
    expect(canSkip({ kind: "Idle" }, baseConfig)).toBe(false);
    expect(canSkip({ kind: "Complete" }, baseConfig)).toBe(false);
  });

  it("returns false for Gated, Reviewing, CompletenessCheck, FinalPasses", () => {
    expect(canSkip({ kind: "Gated", sliceNumber: 1, planText: "p", attempt: 1 }, baseConfig)).toBe(false);
    expect(canSkip({ kind: "Reviewing", sliceNumber: 1, cycle: 1 }, baseConfig)).toBe(false);
    expect(canSkip({ kind: "CompletenessCheck", sliceNumber: 1 }, baseConfig)).toBe(false);
    expect(canSkip({ kind: "FinalPasses", passIndex: 0 }, baseConfig)).toBe(false);
  });
});

describe("isAlreadyImplemented", () => {
  const sha = "abc123";

  it("returns true when text contains 'already implemented' and SHAs match", () => {
    expect(isAlreadyImplemented("The feature is already implemented.", sha, sha)).toBe(true);
  });

  it("returns true for 'tests are already' pattern", () => {
    expect(isAlreadyImplemented("tests are already passing", sha, sha)).toBe(true);
  });

  it("returns true for 'code already' pattern", () => {
    expect(isAlreadyImplemented("code already works fine", sha, sha)).toBe(true);
  });

  it("returns true for 'implementation already' pattern", () => {
    expect(isAlreadyImplemented("implementation already done", sha, sha)).toBe(true);
  });

  it("returns true for 'already passing' pattern", () => {
    expect(isAlreadyImplemented("already passing all checks", sha, sha)).toBe(true);
  });

  it("returns true for 'no changes needed' pattern", () => {
    expect(isAlreadyImplemented("no changes needed here", sha, sha)).toBe(true);
  });

  it("returns true for 'all tests pass' pattern", () => {
    expect(isAlreadyImplemented("all tests pass successfully", sha, sha)).toBe(true);
  });

  it("returns false when text matches but SHAs differ", () => {
    expect(isAlreadyImplemented("already implemented", "abc", "def")).toBe(false);
  });

  it("returns false when SHAs match but text doesn't match", () => {
    expect(isAlreadyImplemented("wrote new code for feature", sha, sha)).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isAlreadyImplemented("Already Implemented", sha, sha)).toBe(true);
    expect(isAlreadyImplemented("ALREADY IMPLEMENTED", sha, sha)).toBe(true);
    expect(isAlreadyImplemented("No Changes Needed", sha, sha)).toBe(true);
  });
});
