import { describe, it, expect, vi } from "vitest";
import { createInjector } from "typed-inject";

vi.mock("../src/infrastructure/claude/claude-agent-factory.js", () => ({
  spawnClaudeAgent: vi.fn(),
  spawnClaudePlanAgent: vi.fn(),
  TDD_RULES_REMINDER: "tdd rules",
  REVIEW_RULES_REMINDER: "review rules",
  buildRulesReminder: vi.fn((base: string, custom?: string) =>
    custom ? `${base}\n${custom}` : base,
  ),
}));

import type { OrchestratorConfig } from "#domain/config.js";
import { RunOrchestration } from "#application/run-orchestration.js";

const makeConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief text",
  auto: true,
  reviewThreshold: 30,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  tddSkill: "tdd-skill",
  reviewSkill: "review-skill",
  verifySkill: "verify-skill",
  gapDisabled: false,
  planDisabled: false,
  maxReplans: 2,
  provider: "claude",
  tddRules: "custom tdd",
  reviewRules: "custom review",
});

describe("composition-root", () => {
  it("typed-inject is importable", () => {
    expect(typeof createInjector).toBe("function");
  });

  it("createContainer resolves RunOrchestration with all deps", async () => {
    const { createContainer } = await import("../src/composition-root.js");
    const config = makeConfig();
    const dummyHud = {
      askUser: vi.fn(),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      wrapLog: vi.fn(),
      createWriter: vi.fn(),
      setSkipping: vi.fn(),
    } as any;

    const container = createContainer(config, dummyHud);
    const orch = container.resolve("runOrchestration");
    expect(orch).toBeInstanceOf(RunOrchestration);
  });

  it("resolved progressSink teardown is callable", async () => {
    const { createContainer } = await import("../src/composition-root.js");
    const config = makeConfig();
    const dummyHud = {
      askUser: vi.fn(),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      wrapLog: vi.fn(),
      createWriter: vi.fn(),
      setSkipping: vi.fn(),
    } as any;

    const container = createContainer(config, dummyHud);
    const sink = container.resolve("progressSink");
    // auto = true → SilentProgressSink → teardown is a no-op, shouldn't throw
    expect(() => sink.teardown()).not.toThrow();
  });
});
