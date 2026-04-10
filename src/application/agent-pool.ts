import type { AgentHandle, AgentSpawner } from "#application/ports/agent-spawner.port.js";
import { RolePromptResolver } from "#application/ports/role-prompt-resolver.port.js";
import type { AgentRole } from "#domain/agent-types.js";
import type { OrchestratorConfig, SkillRole } from "#domain/config.js";
import type { OrchestratorState, PersistedAgentSession } from "#domain/state.js";
import { advanceState } from "#domain/state.js";
import type { ComplexityTier } from "#domain/triage.js";

export const LONG_LIVED_ROLES = ["tdd", "review"] as const;
export const GROUP_SCOPED_ROLES = ["verify", "gap"] as const;
export const EPHEMERAL_ROLES = ["completeness", "final", "triage"] as const;

export type LongLivedRole = (typeof LONG_LIVED_ROLES)[number];
export type GroupScopedRole = (typeof GROUP_SCOPED_ROLES)[number];
export type RespawnableRole = LongLivedRole | GroupScopedRole;

export type StateAccessor = {
  readonly get: () => OrchestratorState;
  readonly update: (fn: (state: OrchestratorState) => OrchestratorState) => void;
};

export type PipeAgent = (handle: AgentHandle, role: AgentRole) => void;

const LONG_LIVED_ROLE_SET = new Set<string>(LONG_LIVED_ROLES);
const GROUP_SCOPED_ROLE_SET = new Set<string>(GROUP_SCOPED_ROLES);
const EPHEMERAL_ROLE_SET = new Set<string>(EPHEMERAL_ROLES);

const isLongLivedRole = (role: AgentRole): role is LongLivedRole => LONG_LIVED_ROLE_SET.has(role);

const isGroupScopedRole = (role: AgentRole): role is GroupScopedRole =>
  GROUP_SCOPED_ROLE_SET.has(role);

const usesPooledHandle = (role: AgentRole): role is RespawnableRole =>
  isLongLivedRole(role) || isGroupScopedRole(role);

const isEphemeralRole = (role: AgentRole): boolean => EPHEMERAL_ROLE_SET.has(role);

export const isRespawnableRole = (role: AgentRole): role is RespawnableRole =>
  usesPooledHandle(role);

const agentRoleToSkillRole = (role: AgentRole): SkillRole | null => {
  switch (role) {
    case "tdd":
    case "review":
    case "verify":
    case "plan":
    case "gap":
    case "completeness":
      return role;
    case "final":
    case "triage":
      return null;
  }
};

const fallbackRulesReminder = (config: OrchestratorConfig, role: "tdd" | "review"): string => {
  if (role === "tdd") {
    return config.tddRules ?? "Continue following the TDD rules.";
  }
  return config.reviewRules ?? "Continue following the review rules.";
};

export class AgentPool {
  private readonly handles = new Map<AgentRole, AgentHandle>();
  private readonly firstFlags = new Map<AgentRole, boolean>();

  constructor(
    private readonly agents: AgentSpawner,
    private readonly rolePromptResolver: RolePromptResolver,
    private readonly config: OrchestratorConfig,
    private readonly stateAccessor: StateAccessor,
    private readonly pipeAgent: PipeAgent = () => {},
    private readonly rulesReminder: (role: "tdd" | "review") => string = (role) =>
      fallbackRulesReminder(config, role),
  ) {}

  async ensure(role: AgentRole): Promise<AgentHandle> {
    if (!usesPooledHandle(role)) {
      return this.spawn(role);
    }

    const existing = this.handles.get(role);
    if (existing && existing.alive) {
      return existing;
    }

    this.handles.delete(role);
    this.firstFlags.delete(role);

    const persistedSession = this.persistedSessionFor(role);
    const handle = this.spawn(role, persistedSession?.id);

    this.handles.set(role, handle);
    this.persistSession(role, handle);
    this.firstFlags.set(role, persistedSession === undefined);

    if (role === "tdd" || role === "review") {
      if (persistedSession === undefined) {
        await handle.sendQuiet(this.rulesReminder(role));
      }
    }

    return handle;
  }

  kill(role: AgentRole): void {
    const handle = this.handles.get(role);
    if (!handle) {
      return;
    }

    handle.kill();
    this.handles.delete(role);
    this.firstFlags.delete(role);

    if (isRespawnableRole(role)) {
      this.clearPersistedSession(role);
    }
  }

  killGroupScoped(): void {
    for (const role of GROUP_SCOPED_ROLES) {
      const handle = this.handles.get(role);
      if (handle) {
        handle.kill();
        this.handles.delete(role);
        this.firstFlags.delete(role);
      }
    }

    this.stateAccessor.update((state) => advanceState(state, { kind: "groupAgentsCleared" }));
  }

  killAll(): void {
    for (const role of [...this.handles.keys()]) {
      this.kill(role);
    }
  }

  async respawn(role: RespawnableRole): Promise<AgentHandle> {
    const existing = this.handles.get(role);
    if (existing) {
      existing.kill();
    }

    const resumeSessionId = isGroupScopedRole(role)
      ? this.persistedSessionFor(role)?.id
      : undefined;

    const handle = this.spawn(role, resumeSessionId);
    this.handles.set(role, handle);
    this.persistSession(role, handle);
    this.firstFlags.set(role, true);

    if (role === "tdd" || role === "review") {
      await handle.sendQuiet(this.rulesReminder(role));
    }

    return handle;
  }

  async respawnAll(): Promise<void> {
    const roles = [...this.handles.keys()].filter(isRespawnableRole);
    for (const role of roles) {
      await this.respawn(role);
    }
  }

  sessionFor(role: RespawnableRole): PersistedAgentSession | undefined {
    const handle = this.handles.get(role);
    if (handle && handle.alive) {
      return { provider: this.providerForRole(role), id: handle.sessionId };
    }

    return this.persistedSessionFor(role);
  }

  isFirst(role: AgentRole): boolean {
    return this.firstFlags.get(role) ?? false;
  }

  clearFirst(role: AgentRole): void {
    this.firstFlags.set(role, false);
  }

  spawnDetached(role: AgentRole): AgentHandle {
    const skillRole = agentRoleToSkillRole(role);
    const systemPrompt =
      skillRole === null
        ? undefined
        : (this.rolePromptResolver.resolve(skillRole, this.currentTier()) ?? undefined);

    const agentConfig = this.config.agentConfig[role];
    return this.agents.spawn(role, {
      cwd: this.config.cwd,
      model: agentConfig.model,
      planMode: role === "plan" || undefined,
      systemPrompt,
    });
  }

  private currentTier(): ComplexityTier {
    const state = this.stateAccessor.get();
    return state.activeTier ?? state.tier ?? this.config.tier;
  }

  private spawn(role: AgentRole, resumeSessionId?: string): AgentHandle {
    const skillRole = agentRoleToSkillRole(role);
    const systemPrompt =
      skillRole === null
        ? undefined
        : (this.rolePromptResolver.resolve(skillRole, this.currentTier()) ?? undefined);

    const agentConfig = this.config.agentConfig[role];
    const handle = this.agents.spawn(role, {
      cwd: this.config.cwd,
      model: agentConfig.model,
      planMode: role === "plan" || undefined,
      resumeSessionId,
      systemPrompt,
    });

    this.pipeAgent(handle, role);
    if (!isEphemeralRole(role)) {
      this.firstFlags.set(role, true);
    }
    return handle;
  }

  private providerForRole(role: RespawnableRole): PersistedAgentSession["provider"] {
    return this.config.agentConfig[role].provider;
  }

  private persistedSessionFor(role: RespawnableRole): PersistedAgentSession | undefined {
    const state = this.stateAccessor.get();
    const session =
      role === "tdd"
        ? state.tddSession
        : role === "review"
          ? state.reviewSession
          : role === "verify"
            ? state.verifySession
            : state.gapSession;

    if (session && session.provider === this.providerForRole(role)) {
      return session;
    }

    return undefined;
  }

  private persistSession(role: RespawnableRole, handle: AgentHandle): void {
    this.stateAccessor.update((state) =>
      advanceState(state, {
        kind: "agentSpawned",
        role,
        session: { provider: this.providerForRole(role), id: handle.sessionId },
      }),
    );
  }

  private clearPersistedSession(role: RespawnableRole): void {
    this.stateAccessor.update((state) => {
      switch (role) {
        case "tdd":
          return { ...state, tddSession: undefined };
        case "review":
          return { ...state, reviewSession: undefined };
        case "verify":
          return { ...state, verifySession: undefined };
        case "gap":
          return { ...state, gapSession: undefined };
      }
    });
  }
}
