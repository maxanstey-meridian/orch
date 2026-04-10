import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi, afterEach } from "vitest";
import { AgentSpawner, type AgentHandle } from "#application/ports/agent-spawner.port.js";
import { RunOrchestration } from "#application/run-orchestration.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { AgentResult, AgentRole, AgentStyle } from "#domain/agent-types.js";
import type { OrchestratorConfig, SkillSet } from "#domain/config.js";
import type { Group, Slice } from "#domain/plan.js";
import { InkProgressSink } from "#infrastructure/progress/ink-progress-sink.js";
import { HudView, type HudState } from "#infrastructure/progress/hud.js";
import { SilentOperatorGate } from "#ui/ink-operator-gate.js";
import { FakeAgentSpawner } from "../fakes/fake-agent-spawner.js";
import { FakeExecutionUnitTierSelector } from "../fakes/fake-execution-unit-tier-selector.js";
import { FakeExecutionUnitTriager } from "../fakes/fake-execution-unit-triager.js";
import { InMemoryGitOps } from "../fakes/fake-git-ops.js";
import { FakeHud } from "../fakes/fake-hud.js";
import { FakeLogWriter } from "../fakes/fake-log-writer.js";
import { PassthroughPromptBuilder } from "../fakes/fake-prompt-builder.js";
import { FakeRolePromptResolver } from "../fakes/fake-role-prompt-resolver.js";
import { InMemoryStatePersistence } from "../fakes/fake-state-persistence.js";

const DEFAULT_SKILLS: SkillSet = {
  tdd: "test",
  review: null,
  verify: null,
  plan: null,
  gap: null,
  completeness: null,
};

const createConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief",
  executionMode: "sliced",
  executionPreference: "auto",
  auto: true,
  reviewThreshold: 30,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  logPath: null,
  tier: "medium",
  skills: DEFAULT_SKILLS,
  maxReplans: 3,
  defaultProvider: "claude",
  agentConfig: AGENT_DEFAULTS,
  ...overrides,
});

const okResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test-session",
  ...overrides,
});

const makeSlice = (number: number, overrides?: Partial<Slice>): Slice => ({
  number,
  title: `Slice ${number}`,
  content: `content for slice ${number}`,
  why: `reason ${number}`,
  files: [{ path: `src/slice-${number}.ts`, action: "new" }],
  details: `details ${number}`,
  tests: `tests ${number}`,
  ...overrides,
});

const makeGroup = (name: string, slices: readonly Slice[]): Group => ({ name, slices });

const reduceHudState = (updates: readonly Array<Partial<HudState>>): HudState => updates.reduce(
  (state, update) => ({
    ...state,
    ...update,
  }),
  {
    totalSlices: 0,
    completedSlices: 0,
    startTime: Date.now(),
  },
);

const createRuntime = (
  spawner: AgentSpawner,
  progressSink: InkProgressSink,
  config = createConfig(),
) => new RunOrchestration(
  spawner,
  new InMemoryStatePersistence(),
  new SilentOperatorGate(),
  new InMemoryGitOps(),
  new PassthroughPromptBuilder(),
  config,
  progressSink,
  new FakeLogWriter(),
  new FakeRolePromptResolver(),
  new FakeExecutionUnitTierSelector(),
  new FakeExecutionUnitTriager(),
);

class StreamingAgentHandle implements AgentHandle {
  readonly sessionId = "tdd-1";
  readonly style: AgentStyle = { label: "TDD", color: "#0ff", badge: "[TDD]" };
  readonly stderr = "";
  alive = true;
  readonly sentPrompts: string[] = [];

  async send(
    prompt: string,
    onText?: (text: string) => void,
  ): Promise<AgentResult> {
    this.sentPrompts.push(prompt);
    onText?.("Thinking through the slice");

    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(okResult({ assistantText: "implemented slice", sessionId: this.sessionId }));
      }, 50);
    });
  }

  async sendQuiet(_prompt: string): Promise<string> {
    return "ok";
  }

  inject(_message: string): void {}

  kill(): void {
    this.alive = false;
  }

  pipe(_onText: (text: string) => void, _onToolUse: (summary: string) => void): void {}
}

class StreamingAgentSpawner extends AgentSpawner {
  readonly handle = new StreamingAgentHandle();

  spawn(role: AgentRole): AgentHandle {
    if (role !== "tdd") {
      throw new Error(`Unexpected role: ${role}`);
    }

    return this.handle;
  }
}

describe("infrastructure progress runtime path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the infrastructure HUD status line from real orchestration updates", async () => {
    const hud = new FakeHud();
    const progressSink = new InkProgressSink(hud);
    const spawner = new FakeAgentSpawner();
    spawner.onNextSpawn("tdd", okResult({ assistantText: "implemented slice 1" }));

    const uc = createRuntime(spawner, progressSink);
    uc.retryDelayMs = 0;
    uc.minAgentDurationMs = 0;

    await uc.execute([makeGroup("G1", [makeSlice(1)])]);

    expect(hud.updates.some((update) => update.executionMode === "sliced")).toBe(true);

    const app = render(
      React.createElement(HudView, {
        items: [],
        state: reduceHudState(hud.updates),
        mode: "status",
        inputText: "",
        askLabel: "",
        skipping: false,
        activity: "",
        spinIndex: 0,
        columns: 120,
      }),
    );

    expect(app.lastFrame()).toContain("Mode: sliced");
    app.unmount();
  });

  it("shows planning activity through the infrastructure progress sink during orchestration streaming", async () => {
    vi.useFakeTimers();

    const hud = new FakeHud();
    const progressSink = new InkProgressSink(hud, { planningDelayMs: 10 });
    const spawner = new StreamingAgentSpawner();
    const uc = createRuntime(spawner, progressSink);
    uc.retryDelayMs = 0;
    uc.minAgentDurationMs = 0;

    const execution = uc.execute([makeGroup("G1", [makeSlice(1)])]);

    await vi.advanceTimersByTimeAsync(10);
    expect(hud.activityHistory).toContain("planning...");

    await vi.advanceTimersByTimeAsync(50);
    await execution;

    expect(spawner.handle.sentPrompts).toHaveLength(1);
  });
});
