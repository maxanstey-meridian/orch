import { createInjector, type Injector } from "typed-inject";
import { PipelineRuntime } from "#application/pipeline-runtime.js";
import type { AgentSpawner } from "#application/ports/agent-spawner.port.js";
import type { ExecutionUnitTierSelector } from "#application/ports/execution-unit-tier-selector.port.js";
import type { ExecutionUnitTriager } from "#application/ports/execution-unit-triager.port.js";
import type { GitOps } from "#application/ports/git-ops.port.js";
import type { LogWriter } from "#application/ports/log-writer.port.js";
import type { OperatorGate } from "#application/ports/operator-gate.port.js";
import type { ProgressSink } from "#application/ports/progress-sink.port.js";
import type { PromptBuilder } from "#application/ports/prompt-builder.port.js";
import type { RolePromptResolver } from "#application/ports/role-prompt-resolver.port.js";
import type { RuntimeInteractionGate } from "#application/ports/runtime-interaction.port.js";
import type { StatePersistence } from "#application/ports/state-persistence.port.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { agentSpawnerFactory } from "#infrastructure/factories.js";
import { InkOperatorGate } from "#infrastructure/gate/ink-operator-gate.js";
import { InkRuntimeInteractionGate } from "#infrastructure/gate/ink-runtime-interaction-gate.js";
import { SilentOperatorGate } from "#infrastructure/gate/silent-operator-gate.js";
import { SilentRuntimeInteractionGate } from "#infrastructure/gate/silent-runtime-interaction-gate.js";
import { ChildProcessGitOps } from "#infrastructure/git/child-process-git-ops.js";
import { FsLogWriter, NullLogWriter } from "#infrastructure/log/fs-log-writer.js";
import { InkProgressSink } from "#infrastructure/progress/ink-progress-sink.js";
import { DefaultPromptBuilder } from "#infrastructure/prompts/default-prompt-builder.js";
import { FileSystemRolePromptResolver } from "#infrastructure/prompts/skill-loader.js";
import { FsStatePersistence } from "#infrastructure/state/fs-state-persistence.js";
import { AgentExecutionUnitTierSelector } from "#infrastructure/triage/agent-execution-unit-tier-selector.js";
import { AgentExecutionUnitTriager } from "#infrastructure/triage/agent-execution-unit-triager.js";
import type { Hud } from "#ui/hud.js";

type ContainerTokens = {
  readonly config: OrchestratorConfig;
  readonly hud: Hud;
  readonly runtimeInteractionGate: RuntimeInteractionGate;
  readonly operatorGate: OperatorGate;
  readonly agentSpawner: AgentSpawner;
  readonly statePersistence: StatePersistence;
  readonly gitOps: GitOps;
  readonly logWriter: LogWriter;
  readonly progressSink: ProgressSink;
  readonly promptBuilder: PromptBuilder;
  readonly rolePromptResolver: RolePromptResolver;
  readonly executionUnitTriager: ExecutionUnitTriager;
  readonly executionUnitTierSelector: ExecutionUnitTierSelector;
  readonly pipelineRuntime: PipelineRuntime;
};

const runtimeInteractionGateFactory = (
  config: OrchestratorConfig,
  hud: Hud,
): RuntimeInteractionGate =>
  config.auto ? new SilentRuntimeInteractionGate() : new InkRuntimeInteractionGate(hud);
runtimeInteractionGateFactory.inject = ["config", "hud"] as const;

const operatorGateFactory = (
  config: OrchestratorConfig,
  hud: Hud,
): OperatorGate => (config.auto ? new SilentOperatorGate() : new InkOperatorGate(hud));
operatorGateFactory.inject = ["config", "hud"] as const;

const statePersistenceFactory = (config: OrchestratorConfig): StatePersistence =>
  new FsStatePersistence(config.stateFile);
statePersistenceFactory.inject = ["config"] as const;

const gitOpsFactory = (config: OrchestratorConfig): GitOps => new ChildProcessGitOps(config.cwd);
gitOpsFactory.inject = ["config"] as const;

const logWriterFactory = (config: OrchestratorConfig): LogWriter =>
  config.logPath === null ? new NullLogWriter() : new FsLogWriter(config.logPath);
logWriterFactory.inject = ["config"] as const;

const progressSinkFactory = (hud: Hud): ProgressSink => new InkProgressSink(hud);
progressSinkFactory.inject = ["hud"] as const;

const promptBuilderFactory = (config: OrchestratorConfig): PromptBuilder =>
  new DefaultPromptBuilder(config.brief, config.planContent, config.tddRules, config.reviewRules);
promptBuilderFactory.inject = ["config"] as const;

const rolePromptResolverFactory = (config: OrchestratorConfig): RolePromptResolver =>
  new FileSystemRolePromptResolver(config.skillOverrides);
rolePromptResolverFactory.inject = ["config"] as const;

const executionUnitTriagerFactory = (
  agentSpawner: AgentSpawner,
  config: OrchestratorConfig,
): ExecutionUnitTriager => new AgentExecutionUnitTriager(agentSpawner, config);
executionUnitTriagerFactory.inject = ["agentSpawner", "config"] as const;

const executionUnitTierSelectorFactory = (
  agentSpawner: AgentSpawner,
  config: OrchestratorConfig,
): ExecutionUnitTierSelector => new AgentExecutionUnitTierSelector(agentSpawner, config);
executionUnitTierSelectorFactory.inject = ["agentSpawner", "config"] as const;

export type OrchContainer = Injector<ContainerTokens>;

export const createContainer = (config: OrchestratorConfig, hud: Hud): OrchContainer =>
  createInjector()
    .provideValue("config", config)
    .provideValue("hud", hud)
    .provideFactory("runtimeInteractionGate", runtimeInteractionGateFactory)
    .provideFactory("operatorGate", operatorGateFactory)
    .provideFactory("agentSpawner", agentSpawnerFactory)
    .provideFactory("statePersistence", statePersistenceFactory)
    .provideFactory("gitOps", gitOpsFactory)
    .provideFactory("logWriter", logWriterFactory)
    .provideFactory("progressSink", progressSinkFactory)
    .provideFactory("promptBuilder", promptBuilderFactory)
    .provideFactory("rolePromptResolver", rolePromptResolverFactory)
    .provideFactory("executionUnitTriager", executionUnitTriagerFactory)
    .provideFactory("executionUnitTierSelector", executionUnitTierSelectorFactory)
    .provideClass("pipelineRuntime", PipelineRuntime);
