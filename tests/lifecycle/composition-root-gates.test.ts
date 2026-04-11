import { afterEach, describe, expect, it } from "vitest";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { createContainer } from "../../src/composition-root.js";
import { FakeHud } from "../fakes/fake-hud.js";

const makeConfig = (auto: boolean): OrchestratorConfig => ({
  cwd: "/tmp/orch",
  planPath: "/tmp/orch/plan.json",
  planContent: "{\"groups\":[]}",
  brief: "brief",
  executionMode: "sliced",
  executionPreference: "auto",
  auto,
  reviewThreshold: 30,
  maxReviewCycles: 3,
  stateFile: "/tmp/orch/state.json",
  logPath: null,
  tier: "medium",
  skills: {
    tdd: "tdd-skill",
    review: "review-skill",
    verify: "verify-skill",
    plan: "plan-skill",
    gap: "gap-skill",
    completeness: "completeness-skill",
  },
  skillOverrides: {},
  maxReplans: 2,
  defaultProvider: "claude",
  agentConfig: AGENT_DEFAULTS,
});

const containers: Array<ReturnType<typeof createContainer>> = [];

afterEach(async () => {
  while (containers.length > 0) {
    const container = containers.pop();
    if (container !== undefined) {
      await container.dispose();
    }
  }
});

describe("composition root gate wiring", () => {
  it("resolves silent gates in auto mode", async () => {
    const hud = new FakeHud();
    const container = createContainer(makeConfig(true), hud);
    containers.push(container);

    const operatorGate = container.resolve("operatorGate");
    const runtimeInteractionGate = container.resolve("runtimeInteractionGate");

    await expect(operatorGate.confirmPlan("preview")).resolves.toEqual({ kind: "accept" });
    await expect(
      runtimeInteractionGate.decide({
        kind: "permissionApproval",
        summary: "Need permission",
      }),
    ).resolves.toEqual({ kind: "approve" });
    expect(hud.askPrompts).toEqual([]);
  });

  it("resolves Ink gates in interactive mode", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("e", "focus tests", "no");
    const container = createContainer(makeConfig(false), hud);
    containers.push(container);

    const operatorGate = container.resolve("operatorGate");
    const runtimeInteractionGate = container.resolve("runtimeInteractionGate");

    await expect(operatorGate.confirmPlan("preview")).resolves.toEqual({
      kind: "edit",
      guidance: "focus tests",
    });
    await expect(
      runtimeInteractionGate.decide({
        kind: "permissionApproval",
        summary: "Need permission",
      }),
    ).resolves.toEqual({ kind: "reject" });
    expect(hud.askPrompts).toEqual([
      "Accept plan? (y)es / (e)dit / (r)eplan: ",
      "Guidance for execution: ",
      "Need permission — (y)es / (n)o / (c)ancel: ",
    ]);
  });
});
