import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { OrchestratorConfig } from "#domain/config.js";
import type { OrchestratorState } from "#domain/state.js";
import type { AgentResult } from "#domain/agent-types.js";
import { RunOrchestration } from "#application/run-orchestration.js";
import { InkProgressSink, InkOperatorGate, SilentOperatorGate } from "#ui/ink-operator-gate.js";
import { FakeHud } from "./fake-hud.js";
import { FakeAgentSpawner } from "./fake-agent-spawner.js";
import { InMemoryStatePersistence } from "./fake-state-persistence.js";
import { InMemoryGitOps } from "./fake-git-ops.js";
import { PassthroughPromptBuilder } from "./fake-prompt-builder.js";
import { FakeLogWriter } from "./fake-log-writer.js";

const DEFAULT_CONFIG: OrchestratorConfig = {
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief",
  executionMode: "sliced",
  executionPreference: "auto",
  auto: false,
  reviewThreshold: 30,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  logPath: null,
  tddSkill: "test",
  reviewSkill: "test",
  verifySkill: "test",
  gapDisabled: true,
  planDisabled: false,
  maxReplans: 3,
  defaultProvider: "claude",
  agentConfig: AGENT_DEFAULTS,
};

/** Standard successful AgentResult. Override fields as needed. */
export const okResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test-session",
  ...overrides,
});

export type TestHarness = ReturnType<typeof createTestHarness>;

export const createTestHarness = (opts?: {
  config?: Partial<OrchestratorConfig>;
  state?: OrchestratorState;
  auto?: boolean;
}) => {
  const hud = new FakeHud();
  const spawner = new FakeAgentSpawner();
  const persistence = new InMemoryStatePersistence();
  const git = new InMemoryGitOps();
  const prompts = new PassthroughPromptBuilder();
  const logWriter = new FakeLogWriter();

  // REAL production code — the full chain from HUD through to orchestration
  const progressSink = new InkProgressSink(hud);
  const gate = opts?.auto
    ? new SilentOperatorGate(hud)
    : new InkOperatorGate(hud);

  const config: OrchestratorConfig = {
    ...DEFAULT_CONFIG,
    ...opts?.config,
    ...(opts?.auto === undefined ? {} : { auto: opts.auto }),
  };

  const uc = new RunOrchestration(
    spawner,
    persistence,
    gate,
    git,
    prompts,
    config,
    progressSink,
    logWriter,
  );
  uc.retryDelayMs = 0;

  if (opts?.state) {
    persistence.current = opts.state;
  }

  return { uc, hud, spawner, persistence, git, prompts, progressSink, gate, config, logWriter };
};
