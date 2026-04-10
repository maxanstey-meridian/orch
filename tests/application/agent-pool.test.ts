import { describe, expect, it, vi } from "vitest";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { OrchestratorConfig, SkillSet } from "#domain/config.js";
import type { OrchestratorState } from "#domain/state.js";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
import {
  AgentPool,
  EPHEMERAL_ROLES,
  GROUP_SCOPED_ROLES,
  LONG_LIVED_ROLES,
  isRespawnableRole,
  type StateAccessor,
} from "#application/agent-pool.js";
import { FakeAgentSpawner } from "../fakes/fake-agent-spawner.js";
import { FakeRolePromptResolver } from "../fakes/fake-role-prompt-resolver.js";

const DEFAULT_SKILLS: SkillSet = {
  tdd: "test",
  review: "test",
  verify: "test",
  plan: "test",
  gap: null,
  completeness: "test",
};

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
  tier: "medium",
  skills: DEFAULT_SKILLS,
  maxReplans: 3,
  defaultProvider: "claude",
  agentConfig: AGENT_DEFAULTS,
};

const createStateAccessor = (initial: OrchestratorState = {}): StateAccessor & { state: OrchestratorState } => {
  let state = initial;

  return {
    get state() {
      return state;
    },
    get: () => state,
    update: (fn) => {
      state = fn(state);
    },
  };
};

const createPool = (opts?: {
  config?: Partial<OrchestratorConfig>;
  state?: OrchestratorState;
  rolePromptResolver?: FakeRolePromptResolver;
  pipeAgent?: ReturnType<typeof vi.fn<[AgentHandle, string], void>>;
}) => {
  const spawner = new FakeAgentSpawner();
  const stateAccessor = createStateAccessor(opts?.state);
  const rolePromptResolver = opts?.rolePromptResolver ?? new FakeRolePromptResolver();
  const pipeAgent = opts?.pipeAgent ?? vi.fn<[AgentHandle, string], void>();
  const config: OrchestratorConfig = { ...DEFAULT_CONFIG, ...opts?.config };
  const pool = new AgentPool(
    spawner,
    rolePromptResolver,
    config,
    stateAccessor,
    pipeAgent,
    (role) => `[RULES:${role}]`,
  );

  return { pool, spawner, stateAccessor, rolePromptResolver, pipeAgent, config };
};

describe("AgentPool", () => {
  it("ensure spawns agent on first call", async () => {
    const { pool, spawner } = createPool();

    await pool.ensure("tdd");

    expect(spawner.agentsForRole("tdd")).toHaveLength(1);
  });

  it("ensure returns existing live agent", async () => {
    const { pool, spawner } = createPool();

    const first = await pool.ensure("tdd");
    const second = await pool.ensure("tdd");

    expect(second).toBe(first);
    expect(spawner.agentsForRole("tdd")).toHaveLength(1);
  });

  it("ensure does not send rules reminders for first-time tdd or review spawns", async () => {
    const { pool, spawner } = createPool();

    await pool.ensure("tdd");
    await pool.ensure("review");

    expect(spawner.lastAgent("tdd").quietPrompts).toEqual([]);
    expect(spawner.lastAgent("review").quietPrompts).toEqual([]);
  });

  it("ensure spawns new if previous killed externally", async () => {
    const { pool, spawner } = createPool();

    const first = await pool.ensure("tdd");
    first.kill();
    const second = await pool.ensure("tdd");

    expect(second).not.toBe(first);
    expect(spawner.agentsForRole("tdd")).toHaveLength(2);
  });

  it("kill removes agent from pool", async () => {
    const { pool, spawner } = createPool();

    await pool.ensure("tdd");
    pool.kill("tdd");
    await pool.ensure("tdd");

    expect(spawner.agentsForRole("tdd")).toHaveLength(2);
  });

  it("kill clears the persisted session for respawnable roles", async () => {
    const { pool } = createPool();

    await pool.ensure("tdd");
    pool.kill("tdd");

    expect(pool.sessionFor("tdd")).toBeUndefined();
  });

  it("killGroupScoped kills verify and gap only", async () => {
    const { pool, spawner } = createPool();

    const tdd = await pool.ensure("tdd");
    const review = await pool.ensure("review");
    const verify = await pool.ensure("verify");
    const gap = await pool.ensure("gap");

    pool.killGroupScoped();

    expect(verify.alive).toBe(false);
    expect(gap.alive).toBe(false);
    expect(tdd.alive).toBe(true);
    expect(review.alive).toBe(true);
    expect(pool.sessionFor("verify")).toBeUndefined();
    expect(pool.sessionFor("gap")).toBeUndefined();
    expect(spawner.agentsForRole("verify")).toHaveLength(1);
    expect(spawner.agentsForRole("gap")).toHaveLength(1);
  });

  it("killAll kills everything", async () => {
    const { pool } = createPool();

    const tdd = await pool.ensure("tdd");
    const review = await pool.ensure("review");
    const verify = await pool.ensure("verify");
    const gap = await pool.ensure("gap");

    pool.killAll();

    expect(tdd.alive).toBe(false);
    expect(review.alive).toBe(false);
    expect(verify.alive).toBe(false);
    expect(gap.alive).toBe(false);
  });

  it("respawn kills and spawns fresh", async () => {
    const { pool, spawner } = createPool();

    const first = await pool.ensure("tdd");
    const second = await pool.respawn("tdd");

    expect(first.alive).toBe(false);
    expect(second).not.toBe(first);
    expect(spawner.agentsForRole("tdd")).toHaveLength(2);
  });

  it("respawn sends rules reminder for tdd", async () => {
    const { pool, spawner } = createPool();

    await pool.respawn("tdd");

    expect(spawner.lastAgent("tdd").quietPrompts).toEqual(["[RULES:tdd]"]);
  });

  it("respawn sends rules reminder for review", async () => {
    const { pool, spawner } = createPool();

    const first = await pool.ensure("review");
    const second = await pool.respawn("review");

    expect(first.alive).toBe(false);
    expect(second).not.toBe(first);
    expect(spawner.agentsForRole("review")).toHaveLength(2);
    expect(spawner.lastAgent("review").quietPrompts).toEqual(["[RULES:review]"]);
  });

  it("respawnAll refreshes every pooled role and leaves ephemeral roles detached", async () => {
    const { pool, spawner } = createPool();

    const firstTdd = await pool.ensure("tdd");
    const firstReview = await pool.ensure("review");
    const firstVerify = await pool.ensure("verify");
    const firstGap = await pool.ensure("gap");
    const firstCompleteness = await pool.ensure("completeness");

    await pool.respawnAll();

    expect(firstTdd.alive).toBe(false);
    expect(firstReview.alive).toBe(false);
    expect(firstVerify.alive).toBe(false);
    expect(firstGap.alive).toBe(false);
    expect(firstCompleteness.alive).toBe(true);
    expect(spawner.agentsForRole("tdd")).toHaveLength(2);
    expect(spawner.agentsForRole("review")).toHaveLength(2);
    expect(spawner.agentsForRole("verify")).toHaveLength(2);
    expect(spawner.agentsForRole("gap")).toHaveLength(2);
    expect(spawner.agentsForRole("completeness")).toHaveLength(1);
    expect(spawner.lastAgent("tdd").quietPrompts).toEqual(["[RULES:tdd]"]);
    expect(spawner.lastAgent("review").quietPrompts).toEqual(["[RULES:review]"]);
  });

  it("sessionFor returns provider and id", async () => {
    const { pool, config } = createPool();

    const handle = await pool.ensure("tdd");

    expect(pool.sessionFor("tdd")).toEqual({
      provider: config.agentConfig.tdd.provider,
      id: handle.sessionId,
    });
  });

  it("sessionFor returns undefined for unspawned role", () => {
    const { pool } = createPool();

    expect(pool.sessionFor("gap")).toBeUndefined();
  });

  it("uses the resolved tier-specific system prompt when spawning", async () => {
    const rolePromptResolver = new FakeRolePromptResolver({
      "tdd:small": "tier-small-tdd-prompt",
    });
    const { pool, spawner } = createPool({
      state: { activeTier: "small" },
      rolePromptResolver,
    });

    await pool.ensure("tdd");

    expect(spawner.lastAgent("tdd")).toBeDefined();
    expect(spawner.spawned[0]?.opts?.systemPrompt).toBe("tier-small-tdd-prompt");
  });

  it("pipes spawned agents through the supplied callback", async () => {
    const pipeAgent = vi.fn<[AgentHandle, string], void>();
    const { pool, spawner } = createPool({ pipeAgent });

    await pool.ensure("verify");

    expect(pipeAgent).toHaveBeenCalledTimes(1);
    expect(pipeAgent).toHaveBeenCalledWith(spawner.lastAgent("verify"), "verify");
  });

  it("reuses only persisted sessions from the configured provider", async () => {
    const { pool, spawner } = createPool({
      state: {
        reviewSession: { provider: "codex", id: "review-123" },
      },
    });

    await pool.ensure("review");

    expect(spawner.spawned[0]?.opts?.resumeSessionId).toBeUndefined();
  });

  it.each([
    { role: "verify" as const, persistedId: "verify-123" },
    { role: "gap" as const, persistedId: "gap-123" },
  ])(
    "reuses and refreshes the persisted %s session across ensure and respawn",
    async ({ role, persistedId }) => {
      const { pool, spawner, stateAccessor, config } = createPool({
        state:
          role === "verify"
            ? { verifySession: { provider: configProvider("verify"), id: persistedId } }
            : { gapSession: { provider: configProvider("gap"), id: persistedId } },
      });

      function configProvider(currentRole: "verify" | "gap") {
        return DEFAULT_CONFIG.agentConfig[currentRole].provider;
      }

      const first = await pool.ensure(role);
      const persistedAfterEnsure =
        role === "verify" ? stateAccessor.state.verifySession : stateAccessor.state.gapSession;

      expect(spawner.spawned[0]?.opts?.resumeSessionId).toBe(persistedId);
      expect(persistedAfterEnsure).toEqual({
        provider: config.agentConfig[role].provider,
        id: first.sessionId,
      });

      const second = await pool.respawn(role);
      const persistedAfterRespawn =
        role === "verify" ? stateAccessor.state.verifySession : stateAccessor.state.gapSession;

      expect(first.alive).toBe(false);
      expect(second).not.toBe(first);
      expect(spawner.spawned[1]?.opts?.resumeSessionId).toBe(first.sessionId);
      expect(persistedAfterRespawn).toEqual({
        provider: config.agentConfig[role].provider,
        id: second.sessionId,
      });
    },
  );

  it("resets first-message state on respawn", async () => {
    const { pool } = createPool();

    await pool.ensure("review");
    pool.clearFirst("review");

    await pool.respawn("review");

    expect(pool.isFirst("review")).toBe(true);
  });

  it("treats completeness, final, and triage as ephemeral roles", async () => {
    const { pool, spawner } = createPool();

    const firstCompleteness = await pool.ensure("completeness");
    const secondCompleteness = await pool.ensure("completeness");
    const firstFinal = await pool.ensure("final");
    const secondFinal = await pool.ensure("final");
    const firstTriage = await pool.ensure("triage");
    const secondTriage = await pool.ensure("triage");

    expect(firstCompleteness).not.toBe(secondCompleteness);
    expect(firstFinal).not.toBe(secondFinal);
    expect(firstTriage).not.toBe(secondTriage);
    expect(spawner.agentsForRole("completeness")).toHaveLength(2);
    expect(spawner.agentsForRole("final")).toHaveLength(2);
    expect(spawner.agentsForRole("triage")).toHaveLength(2);
  });

  it("exports the expected role categories and respawnability helper", () => {
    expect(LONG_LIVED_ROLES).toEqual(["tdd", "review"]);
    expect(GROUP_SCOPED_ROLES).toEqual(["verify", "gap"]);
    expect(EPHEMERAL_ROLES).toEqual(["completeness", "final", "triage"]);
    expect(isRespawnableRole("tdd")).toBe(true);
    expect(isRespawnableRole("review")).toBe(true);
    expect(isRespawnableRole("verify")).toBe(true);
    expect(isRespawnableRole("gap")).toBe(true);
    expect(isRespawnableRole("final")).toBe(false);
  });
});
