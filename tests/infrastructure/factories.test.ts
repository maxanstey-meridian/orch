import { describe, it, expect, vi } from "vitest";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { OrchestratorConfig } from "#domain/config.js";
import type { Hud } from "#ui/hud.js";

const spawnMock = vi.fn(() => ({}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

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

vi.mock("../../src/infrastructure/codex/codex-agent-spawner.js", () => ({
  CodexAgentSpawner: class {
    constructor(
      private readonly _cwd: string,
      private readonly _config: { readonly auto: boolean },
      private readonly processFactory: () => unknown,
      private readonly _gate: unknown,
    ) {}

    spawn() {
      this.processFactory();
      return { send: vi.fn(), kill: vi.fn() };
    }
  },
}));

import { SilentRuntimeInteractionGate } from "#ui/ink-runtime-interaction-gate.js";

const dummyGate = new SilentRuntimeInteractionGate();

const fakeHud = (): Hud => ({
  update: vi.fn(),
  teardown: vi.fn(),
  wrapLog: vi.fn((fn) => fn),
  createWriter: vi.fn(() => vi.fn()),
  onKey: vi.fn(),
  onInterruptSubmit: vi.fn(),
  startPrompt: vi.fn(),
  setSkipping: vi.fn(),
  setActivity: vi.fn(),
  askUser: vi.fn().mockResolvedValue(''),
});

const makeConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief text",
  executionMode: "sliced",
  executionPreference: "auto",
  auto: false,
  reviewThreshold: 30,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  logPath: null,
  tddSkill: "tdd-skill",
  reviewSkill: "review-skill",
  verifySkill: "verify-skill",
  gapDisabled: false,
  planDisabled: false,
  maxReplans: 2,
  defaultProvider: "claude",
  agentConfig: AGENT_DEFAULTS,
  tddRules: "custom tdd",
  reviewRules: "custom review",
  ...overrides,
});

describe("agentSpawnerFactory", () => {
  it("routes claude role to ClaudeAgentSpawner", async () => {
    const mockModule = await import("../../src/infrastructure/claude/claude-agent-factory.js");
    const spawnClaudeAgent = vi.mocked(mockModule.spawnClaudeAgent);
    spawnClaudeAgent.mockClear();

    const { agentSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const config = makeConfig();
    const spawner = agentSpawnerFactory(config, dummyGate);
    spawner.spawn("tdd");
    expect(spawnClaudeAgent).toHaveBeenCalled();
    expect(agentSpawnerFactory.inject).toEqual(["config", "runtimeInteractionGate"]);
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
    const spawner = agentSpawnerFactory(config, dummyGate);
    spawner.spawn("tdd");

    expect(spawnClaudeAgent).toHaveBeenCalledWith(
      expect.anything(),      // style
      "my-tdd-skill",         // systemPrompt from skills.tdd
      undefined,              // resumeSessionId
      "/custom/cwd",          // cwd from config
      undefined,              // model
    );
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
  it("returns SilentOperatorGate when config.auto is true", async () => {
    const { operatorGateFactory } = await import("../../src/infrastructure/factories.js");
    const { SilentOperatorGate } = await import("../../src/ui/ink-operator-gate.js");
    const config = makeConfig({ auto: true });
    const result = operatorGateFactory(config, fakeHud());
    expect(result).toBeInstanceOf(SilentOperatorGate);
    expect(operatorGateFactory.inject).toEqual(["config", "hud"]);
  });

  it("returns InkOperatorGate when config.auto is false", async () => {
    const { operatorGateFactory } = await import("../../src/infrastructure/factories.js");
    const { InkOperatorGate } = await import("../../src/ui/ink-operator-gate.js");
    const config = makeConfig({ auto: false });
    const result = operatorGateFactory(config, fakeHud());
    expect(result).toBeInstanceOf(InkOperatorGate);
  });
});

describe("progressSinkFactory", () => {
  it("always returns InkProgressSink regardless of auto flag", async () => {
    const { progressSinkFactory } = await import("../../src/infrastructure/factories.js");
    const { InkProgressSink } = await import("../../src/ui/ink-operator-gate.js");
    expect(progressSinkFactory(makeConfig({ auto: true }), fakeHud())).toBeInstanceOf(InkProgressSink);
    expect(progressSinkFactory(makeConfig({ auto: false }), fakeHud())).toBeInstanceOf(InkProgressSink);
    expect(progressSinkFactory.inject).toEqual(["config", "hud"]);
  });
});

describe("planGeneratorSpawnerFactory", () => {
  it("returns a spawner function for claude provider", async () => {
    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = planGeneratorSpawnerFactory({ agentConfig: AGENT_DEFAULTS, cwd: "/tmp/test" });
    expect(typeof spawner).toBe("function");
  });

  it("returns a spawner function for codex provider", async () => {
    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = planGeneratorSpawnerFactory({
      agentConfig: { ...AGENT_DEFAULTS, plan: { provider: "codex" } },
      cwd: "/tmp",
    });
    expect(typeof spawner).toBe("function");
  });

  it("returned spawner produces an object with send and kill", async () => {
    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = planGeneratorSpawnerFactory({ agentConfig: AGENT_DEFAULTS, cwd: "/tmp" });
    const agent = spawner();

    expect(agent).toHaveProperty("send");
    expect(agent).toHaveProperty("kill");
    expect(typeof agent.send).toBe("function");
    expect(typeof agent.kill).toBe("function");
  });

  it("uses the default codex app-server model for codex plan generation", async () => {
    spawnMock.mockClear();

    const { planGeneratorSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = planGeneratorSpawnerFactory({
      agentConfig: { ...AGENT_DEFAULTS, plan: { provider: "codex" } },
      cwd: "/tmp",
    });

    spawner();

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server"],
      expect.objectContaining({
        cwd: "/tmp",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

});

describe("requestTriageSpawnerFactory", () => {
  it("returns a prompt agent for claude triage and forwards the configured model", async () => {
    const mockModule = await import("../../src/infrastructure/claude/claude-agent-factory.js");
    const spawnClaudePlanAgent = vi.mocked(mockModule.spawnClaudePlanAgent);
    spawnClaudePlanAgent.mockClear();
    spawnClaudePlanAgent.mockReturnValue({
      send: vi.fn(),
      kill: vi.fn(),
    } as never);

    const { requestTriageSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = requestTriageSpawnerFactory({
      agentConfig: {
        ...AGENT_DEFAULTS,
        triage: {
          provider: "claude",
          model: "claude-haiku-4-5-20251001",
        },
      },
      cwd: "/tmp/request-triage",
    });

    const agent = spawner();

    expect(agent).toHaveProperty("send");
    expect(agent).toHaveProperty("kill");
    expect(spawnClaudePlanAgent).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "/tmp/request-triage",
      "claude-haiku-4-5-20251001",
    );
  });

  it("returns a prompt agent for codex triage and uses the configured model", async () => {
    spawnMock.mockClear();

    const { requestTriageSpawnerFactory } = await import("../../src/infrastructure/factories.js");
    const spawner = requestTriageSpawnerFactory({
      agentConfig: {
        ...AGENT_DEFAULTS,
        triage: {
          provider: "codex",
          model: "gpt-5.4",
        },
      },
      cwd: "/tmp/request-triage",
    });

    const agent = spawner();

    expect(agent).toHaveProperty("send");
    expect(agent).toHaveProperty("kill");
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server", "-c", 'model="gpt-5.4"'],
      expect.objectContaining({
        cwd: "/tmp/request-triage",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
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

describe("logWriterFactory", () => {
  it("returns NullLogWriter when config.logPath is null and FsLogWriter otherwise", async () => {
    const { logWriterFactory } = await import("../../src/infrastructure/factories.js");
    const { FsLogWriter, NullLogWriter } = await import("../../src/infrastructure/log/log-writer.js");

    expect(logWriterFactory(makeConfig({ logPath: null }))).toBeInstanceOf(NullLogWriter);
    expect(logWriterFactory(makeConfig({ logPath: "/tmp/test.log" }))).toBeInstanceOf(FsLogWriter);
    expect(logWriterFactory.inject).toEqual(["config"]);
  });
});
