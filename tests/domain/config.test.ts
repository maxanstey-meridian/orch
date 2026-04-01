import { describe, it, expect } from "vitest";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { OrchestratorConfig } from "#domain/config.js";

describe("OrchestratorConfig", () => {
  it("accepts a valid config with all required fields", () => {
    const config: OrchestratorConfig = {
      cwd: "/tmp",
      planPath: "/tmp/plan.json",
      planContent: "content",
      brief: "brief",
      auto: false,
      reviewThreshold: 30,
      maxReviewCycles: 3,
      stateFile: "/tmp/state.json",
      logPath: null,
      tddSkill: null,
      reviewSkill: null,
      verifySkill: null,
      gapDisabled: false,
      planDisabled: false,
      maxReplans: 2,
      defaultProvider: "claude",
      agentConfig: AGENT_DEFAULTS,
    };
    expect(config.cwd).toBe("/tmp");
  });

  it("accepts optional tddRules and reviewRules", () => {
    const config: OrchestratorConfig = {
      cwd: "/tmp",
      planPath: "/tmp/plan.json",
      planContent: "content",
      brief: "brief",
      auto: false,
      reviewThreshold: 30,
      maxReviewCycles: 3,
      stateFile: "/tmp/state.json",
      logPath: "/tmp/run.log",
      tddSkill: "custom-tdd",
      reviewSkill: "custom-review",
      verifySkill: "custom-verify",
      gapDisabled: true,
      planDisabled: true,
      maxReplans: 5,
      defaultProvider: "claude",
      agentConfig: AGENT_DEFAULTS,
      tddRules: "custom rules",
      reviewRules: "custom review rules",
    };
    expect(config.tddRules).toBe("custom rules");
    expect(config.reviewRules).toBe("custom review rules");
  });
});
