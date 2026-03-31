import { describe, it, expect } from "vitest";
import { AGENT_ROLES } from "#domain/agent-types.js";
import type { AgentStyle, AgentResult, AgentRole } from "#domain/agent-types.js";

describe("AgentStyle", () => {
  it("is structurally constructable", () => {
    const style: AgentStyle = { label: "TDD", color: "green", badge: "T" };
    expect(style.label).toBe("TDD");
    expect(style.color).toBe("green");
    expect(style.badge).toBe("T");
  });
});

describe("AgentResult", () => {
  it("is structurally constructable without planText", () => {
    const result: AgentResult = {
      exitCode: 0,
      assistantText: "done",
      resultText: "ok",
      needsInput: false,
      sessionId: "abc",
    };
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("abc");
  });

  it("accepts optional planText", () => {
    const result: AgentResult = {
      exitCode: 0,
      assistantText: "",
      resultText: "",
      needsInput: false,
      sessionId: "abc",
      planText: "the plan",
    };
    expect(result.planText).toBe("the plan");
  });
});

describe("AgentRole", () => {
  it("exports the full runtime AGENT_ROLES array including triage", () => {
    expect(AGENT_ROLES).toEqual([
      "tdd",
      "review",
      "verify",
      "plan",
      "gap",
      "final",
      "completeness",
      "triage",
    ]);
  });

  it("covers all 8 roles (exhaustiveness guard)", () => {
    const allRoles: Record<AgentRole, true> = {
      tdd: true,
      review: true,
      verify: true,
      plan: true,
      gap: true,
      final: true,
      completeness: true,
      triage: true,
    };
    expect(Object.keys(allRoles)).toHaveLength(8);
  });
});
