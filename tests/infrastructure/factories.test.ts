import { describe, it, expect, vi } from "vitest";
import type { OrchestratorConfig } from "../../src/domain/config.js";

vi.mock("../../src/infrastructure/claude/claude-agent-factory.js", () => ({
  spawnClaudeAgent: vi.fn(),
  spawnClaudePlanAgent: vi.fn(),
  spawnClaudeGeneratePlanAgent: vi.fn(() => ({ send: vi.fn(), kill: vi.fn() })),
  TDD_RULES_REMINDER: "tdd rules",
  REVIEW_RULES_REMINDER: "review rules",
  buildRulesReminder: vi.fn((base: string, custom?: string) =>
    custom ? `${base}\n${custom}` : base,
  ),
}));

const makeConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief text",
  noInteraction: false,
  auto: false,
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
  ...overrides,
});

describe("agentSpawnerFactory", () => {
  it("creates ClaudeAgentSpawner from config with correct skills and cwd", async () => {
    const { agentSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const { ClaudeAgentSpawner } = await import(
      "../../src/infrastructure/claude-agent-spawner.js"
    );
    const config = makeConfig();
    const result = agentSpawnerFactory(config);
    expect(result).toBeInstanceOf(ClaudeAgentSpawner);
    expect(agentSpawnerFactory.inject).toEqual(["config"]);
  });

  it("passes config skills and cwd through to the spawner", async () => {
    const mockModule = await import("../../src/infrastructure/claude/claude-agent-factory.js");
    const spawnClaudeAgent = vi.mocked(mockModule.spawnClaudeAgent);
    spawnClaudeAgent.mockClear();

    const { agentSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const config = makeConfig({
      tddSkill: "my-tdd-skill",
      cwd: "/custom/cwd",
    });
    const spawner = agentSpawnerFactory(config);
    spawner.spawn("tdd");

    expect(spawnClaudeAgent).toHaveBeenCalledWith(
      expect.anything(),      // style
      "my-tdd-skill",         // systemPrompt from skills.tdd
      undefined,              // resumeSessionId
      "/custom/cwd",          // cwd from config
    );
  });

  it("throws for codex provider (not yet implemented)", async () => {
    const { agentSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const config = makeConfig({ provider: "codex" });
    expect(() => agentSpawnerFactory(config)).toThrow("not yet implemented");
  });
});

describe("statePersistenceFactory", () => {
  it("creates FsStatePersistence from config.stateFile", async () => {
    const { statePersistenceFactory } = await import("../../src/infrastructure/factories.js");
    const { FsStatePersistence } = await import(
      "../../src/infrastructure/fs-state-persistence.js"
    );
    const config = makeConfig({ stateFile: "/custom/state.json" });
    const result = statePersistenceFactory(config);
    expect(result).toBeInstanceOf(FsStatePersistence);
    expect(statePersistenceFactory.inject).toEqual(["config"]);
  });
});

describe("gitOpsFactory", () => {
  it("creates ChildProcessGitOps from config.cwd", async () => {
    const { gitOpsFactory } = await import("../../src/infrastructure/factories.js");
    const { ChildProcessGitOps } = await import(
      "../../src/infrastructure/child-process-git-ops.js"
    );
    const config = makeConfig({ cwd: "/my/project" });
    const result = gitOpsFactory(config);
    expect(result).toBeInstanceOf(ChildProcessGitOps);
    expect(gitOpsFactory.inject).toEqual(["config"]);
  });
});

describe("operatorGateFactory", () => {
  it("returns SilentOperatorGate when config.noInteraction is true", async () => {
    const { operatorGateFactory } = await import("../../src/infrastructure/factories.js");
    const { SilentOperatorGate } = await import("../../src/ui/ink-operator-gate.js");
    const config = makeConfig({ noInteraction: true });
    const dummyHud = {} as any;
    const result = operatorGateFactory(config, dummyHud);
    expect(result).toBeInstanceOf(SilentOperatorGate);
    expect(operatorGateFactory.inject).toEqual(["config", "hud"]);
  });

  it("returns InkOperatorGate when config.noInteraction is false", async () => {
    const { operatorGateFactory } = await import("../../src/infrastructure/factories.js");
    const { InkOperatorGate } = await import("../../src/ui/ink-operator-gate.js");
    const config = makeConfig({ noInteraction: false });
    const dummyHud = {
      askUser: vi.fn(),
      update: vi.fn(),
      setActivity: vi.fn(),
      teardown: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
    } as any;
    const result = operatorGateFactory(config, dummyHud);
    expect(result).toBeInstanceOf(InkOperatorGate);
  });
});

describe("progressSinkFactory", () => {
  it("returns SilentProgressSink when noInteraction", async () => {
    const { progressSinkFactory } = await import("../../src/infrastructure/factories.js");
    const { SilentProgressSink } = await import("../../src/ui/ink-operator-gate.js");
    const config = makeConfig({ noInteraction: true });
    const dummyHud = {} as any;
    const result = progressSinkFactory(config, dummyHud);
    expect(result).toBeInstanceOf(SilentProgressSink);
    expect(progressSinkFactory.inject).toEqual(["config", "hud"]);
  });

  it("returns InkProgressSink when interactive", async () => {
    const { progressSinkFactory } = await import("../../src/infrastructure/factories.js");
    const { InkProgressSink } = await import("../../src/ui/ink-operator-gate.js");
    const config = makeConfig({ noInteraction: false });
    const dummyHud = {
      update: vi.fn(),
      teardown: vi.fn(),
      onKey: vi.fn(),
      onInterruptSubmit: vi.fn(),
      startPrompt: vi.fn(),
      setActivity: vi.fn(),
    } as any;
    const result = progressSinkFactory(config, dummyHud);
    expect(result).toBeInstanceOf(InkProgressSink);
  });
});

describe("planGeneratorSpawnerFactory", () => {
  it("returns a spawner function for claude provider", async () => {
    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = planGeneratorSpawnerFactory({ provider: "claude", cwd: "/tmp/test" });
    expect(typeof spawner).toBe("function");
  });

  it("throws for codex provider", async () => {
    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    expect(() => planGeneratorSpawnerFactory({ provider: "codex", cwd: "/tmp" })).toThrow(
      "not yet implemented",
    );
  });

  it("returned spawner produces an object with send and kill", async () => {
    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = planGeneratorSpawnerFactory({ provider: "claude", cwd: "/tmp" });
    const agent = spawner();

    expect(agent).toHaveProperty("send");
    expect(agent).toHaveProperty("kill");
    expect(typeof agent.send).toBe("function");
    expect(typeof agent.kill).toBe("function");
  });

  it("passes cwd to spawnClaudeGeneratePlanAgent", async () => {
    const mockModule = await import("../../src/infrastructure/claude/claude-agent-factory.js");
    const spawnSpy = vi.mocked(mockModule.spawnClaudeGeneratePlanAgent);
    spawnSpy.mockClear();

    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = planGeneratorSpawnerFactory({ provider: "claude", cwd: "/my/project" });
    spawner();

    expect(spawnSpy).toHaveBeenCalledWith("/my/project");
  });
});

describe("promptBuilderFactory", () => {
  it("creates DefaultPromptBuilder from config brief, planContent, and rules", async () => {
    const { promptBuilderFactory } = await import("../../src/infrastructure/factories.js");
    const { DefaultPromptBuilder } = await import(
      "../../src/infrastructure/default-prompt-builder.js"
    );
    const config = makeConfig();
    const result = promptBuilderFactory(config);
    expect(result).toBeInstanceOf(DefaultPromptBuilder);
    expect(promptBuilderFactory.inject).toEqual(["config"]);
  });
});
