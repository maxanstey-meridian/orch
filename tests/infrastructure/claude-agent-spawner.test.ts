import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRole, AgentStyle } from "#domain/agent-types.js";
import type { ClaudeAgentProcess } from "#infrastructure/claude/claude-agent-process.js";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";

vi.mock("../../src/infrastructure/claude/claude-agent-factory.js", () => ({
  spawnClaudeAgent: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({
      exitCode: 0,
      assistantText: "",
      resultText: "",
      needsInput: false,
      sessionId: "mock-sess",
    }),
    sendQuiet: vi.fn().mockResolvedValue(""),
    inject: vi.fn(),
    kill: vi.fn(),
    pipe: vi.fn(),
    alive: true,
    stderr: "hidden",
    sessionId: "mock-sess",
    style: { label: "TEST", color: "", badge: "" },
  })),
  spawnClaudePlanAgent: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({
      exitCode: 0,
      assistantText: "",
      resultText: "",
      needsInput: false,
      sessionId: "mock-plan-sess",
    }),
    sendQuiet: vi.fn().mockResolvedValue(""),
    inject: vi.fn(),
    kill: vi.fn(),
    pipe: vi.fn(),
    alive: true,
    stderr: "hidden",
    sessionId: "mock-plan-sess",
    style: { label: "PLAN", color: "", badge: "" },
  })),
}));

import { spawnClaudeAgent, spawnClaudePlanAgent } from "#infrastructure/claude/claude-agent-factory.js";
import type { Mock } from "vitest";

const mockedSpawnAgent = spawnClaudeAgent as Mock;
const mockedSpawnPlanAgent = spawnClaudePlanAgent as Mock;

import { ClaudeAgentSpawner } from "#infrastructure/claude-agent-spawner.js";
import { ROLE_STYLES } from "#ui/agent-role-styles.js";
import { BOT_TDD, BOT_REVIEW, BOT_VERIFY, BOT_PLAN, BOT_GAP, BOT_FINAL } from "#ui/display.js";

describe("ClaudeAgentProcess / AgentHandle structural compatibility", () => {
  it("ClaudeAgentProcess structurally satisfies AgentHandle", () => {
    const process = {} as ClaudeAgentProcess;
    const _handle: AgentHandle = process; // compile-time check
    expect(true).toBe(true);
  });
});

describe("ROLE_STYLES", () => {
  it("maps every AgentRole to an AgentStyle", () => {
    const allRoles: AgentRole[] = [
      "tdd",
      "review",
      "verify",
      "plan",
      "gap",
      "final",
      "completeness",
      "triage",
    ];
    const keys = Object.keys(ROLE_STYLES);

    expect(keys).toHaveLength(allRoles.length);
    for (const role of allRoles) {
      expect(keys).toContain(role);
    }
  });

  it("maps each role to its correct BOT_* constant", () => {
    expect(ROLE_STYLES.tdd).toBe(BOT_TDD);
    expect(ROLE_STYLES.review).toBe(BOT_REVIEW);
    expect(ROLE_STYLES.verify).toBe(BOT_VERIFY);
    expect(ROLE_STYLES.plan).toBe(BOT_PLAN);
    expect(ROLE_STYLES.gap).toBe(BOT_GAP);
    expect(ROLE_STYLES.final).toBe(BOT_FINAL);
    expect(ROLE_STYLES.completeness).toBe(BOT_PLAN);
  });

  it("defines the triage style inline", () => {
    expect(ROLE_STYLES.triage.label).toBe("TRG");
    expect(typeof ROLE_STYLES.triage.color).toBe("string");
    expect(typeof ROLE_STYLES.triage.badge).toBe("string");
  });

  it("each value has label, color, and badge strings", () => {
    for (const style of Object.values(ROLE_STYLES)) {
      expect(typeof (style as AgentStyle).label).toBe("string");
      expect(typeof (style as AgentStyle).color).toBe("string");
      expect(typeof (style as AgentStyle).badge).toBe("string");
    }
  });
});

describe("ClaudeAgentSpawner", () => {
  beforeEach(() => {
    mockedSpawnAgent.mockClear();
    mockedSpawnPlanAgent.mockClear();
  });

  const makeSpawner = (
    skills: Partial<Record<AgentRole, string | null>> = {},
    cwd = "/default",
  ) => new ClaudeAgentSpawner(skills, cwd);

  describe("plan-mode roles use spawnPlanAgent", () => {
    it.each(["plan", "gap", "completeness", "triage"] as AgentRole[])(
      "spawn('%s') calls spawnPlanAgent",
      (role) => {
        const spawner = makeSpawner();
        spawner.spawn(role);
        expect(mockedSpawnPlanAgent).toHaveBeenCalledOnce();
        expect(mockedSpawnAgent).not.toHaveBeenCalled();
      },
    );
  });

  describe("non-plan roles use spawnAgent", () => {
    it.each(["tdd", "review", "verify", "final"] as AgentRole[])(
      "spawn('%s') calls spawnAgent",
      (role) => {
        const spawner = makeSpawner();
        spawner.spawn(role);
        expect(mockedSpawnAgent).toHaveBeenCalledOnce();
        expect(mockedSpawnPlanAgent).not.toHaveBeenCalled();
      },
    );
  });

  describe("spawnPlanAgent argument forwarding", () => {
    it("passes style, systemPrompt, and cwd to spawnPlanAgent", () => {
      const spawner = makeSpawner({ plan: "plan skill" }, "/work");
      spawner.spawn("plan", { cwd: "/custom" });
      expect(mockedSpawnPlanAgent).toHaveBeenCalledWith(ROLE_STYLES.plan, "plan skill", "/custom", undefined);
    });

    it("passes the Haiku model override for triage", () => {
      const spawner = makeSpawner({ triage: "triage skill" }, "/work");
      spawner.spawn("triage", { cwd: "/custom" });
      expect(mockedSpawnPlanAgent).toHaveBeenCalledWith(
        ROLE_STYLES.triage,
        "triage skill",
        "/custom",
        "claude-haiku-4-5-20251001",
      );
      expect(mockedSpawnAgent).not.toHaveBeenCalled();
    });

    it("resumeSessionId is not forwarded to spawnPlanAgent", () => {
      const spawner = makeSpawner();
      spawner.spawn("plan", { resumeSessionId: "sess-x" });
      expect(mockedSpawnPlanAgent).toHaveBeenCalledOnce();
      const args = mockedSpawnPlanAgent.mock.calls[0];
      expect(args).toHaveLength(4);
      expect(args[3]).toBeUndefined();
      expect(args).not.toContain("sess-x");
    });
  });

  describe("style forwarding to factory", () => {
    it("passes ROLE_STYLES[role] as first arg to spawnAgent", () => {
      const spawner = makeSpawner();
      spawner.spawn("review");
      const [style] = mockedSpawnAgent.mock.calls[0];
      expect(style).toBe(ROLE_STYLES.review);
    });

    it("passes ROLE_STYLES[role] as first arg to spawnPlanAgent", () => {
      const spawner = makeSpawner();
      spawner.spawn("gap");
      const [style] = mockedSpawnPlanAgent.mock.calls[0];
      expect(style).toBe(ROLE_STYLES.gap);
    });
  });

  describe("skill resolution", () => {
    it("uses skill from config as systemPrompt", () => {
      const spawner = makeSpawner({ tdd: "custom TDD skill content" });
      spawner.spawn("tdd");
      expect(mockedSpawnAgent).toHaveBeenCalledOnce();
      const [, systemPrompt] = mockedSpawnAgent.mock.calls[0];
      expect(systemPrompt).toBe("custom TDD skill content");
    });

    it("null skill passes undefined systemPrompt", () => {
      const spawner = makeSpawner({ review: null });
      spawner.spawn("review");
      const [, systemPrompt] = mockedSpawnAgent.mock.calls[0];
      expect(systemPrompt).toBeUndefined();
    });

    it("missing skill passes undefined systemPrompt", () => {
      const spawner = makeSpawner({});
      spawner.spawn("verify");
      const [, systemPrompt] = mockedSpawnAgent.mock.calls[0];
      expect(systemPrompt).toBeUndefined();
    });
  });

  describe("opts overrides", () => {
    it("opts.cwd overrides defaultCwd", () => {
      const spawner = makeSpawner({}, "/default");
      spawner.spawn("tdd", { cwd: "/override" });
      const [, , , cwd] = mockedSpawnAgent.mock.calls[0];
      expect(cwd).toBe("/override");
    });

    it("uses defaultCwd when opts.cwd not provided", () => {
      const spawner = makeSpawner({}, "/default");
      spawner.spawn("tdd");
      const [, , , cwd] = mockedSpawnAgent.mock.calls[0];
      expect(cwd).toBe("/default");
    });

    it("opts.resumeSessionId passed to spawnAgent", () => {
      const spawner = makeSpawner();
      spawner.spawn("tdd", { resumeSessionId: "sess-abc" });
      const [, , resumeId] = mockedSpawnAgent.mock.calls[0];
      expect(resumeId).toBe("sess-abc");
    });

    it("opts.systemPrompt overrides skill from config", () => {
      const spawner = makeSpawner({ tdd: "skill content" });
      spawner.spawn("tdd", { systemPrompt: "override prompt" });
      const [, systemPrompt] = mockedSpawnAgent.mock.calls[0];
      expect(systemPrompt).toBe("override prompt");
    });

    it("opts.planMode forces spawnPlanAgent for non-plan role", () => {
      const spawner = makeSpawner();
      spawner.spawn("tdd", { planMode: true });
      expect(mockedSpawnPlanAgent).toHaveBeenCalledOnce();
      expect(mockedSpawnAgent).not.toHaveBeenCalled();
    });
  });

  describe("AgentHandle wrapping", () => {
    it("delegates send/sendQuiet/inject/kill to underlying AgentProcess", async () => {
      const mockSend = vi.fn().mockResolvedValue({
        exitCode: 0,
        assistantText: "hello",
        resultText: "ok",
        needsInput: false,
        sessionId: "mock-sess",
      });
      const mockSendQuiet = vi.fn().mockResolvedValue("quiet");
      const mockInject = vi.fn();
      const mockKill = vi.fn();

      mockedSpawnAgent.mockReturnValueOnce({
        send: mockSend,
        sendQuiet: mockSendQuiet,
        inject: mockInject,
        kill: mockKill,
        alive: true,
        stderr: "should-be-hidden",
        sessionId: "mock-sess",
        style: { label: "TDD", color: "", badge: "" },
      });

      const spawner = makeSpawner();
      const handle = spawner.spawn("tdd");

      const onText = vi.fn();
      const onToolUse = vi.fn();
      await handle.send("prompt", onText, onToolUse);
      expect(mockSend).toHaveBeenCalledWith("prompt", onText, onToolUse);

      await handle.sendQuiet("quiet prompt");
      expect(mockSendQuiet).toHaveBeenCalledWith("quiet prompt");

      handle.inject("guidance");
      expect(mockInject).toHaveBeenCalledWith("guidance");

      handle.kill();
      expect(mockKill).toHaveBeenCalled();
    });

    it("exposes sessionId and style from AgentProcess", () => {
      mockedSpawnAgent.mockReturnValueOnce({
        send: vi.fn(),
        sendQuiet: vi.fn(),
        inject: vi.fn(),
        kill: vi.fn(),
        alive: true,
        stderr: "hidden",
        sessionId: "sess-123",
        style: { label: "TDD", color: "cyan", badge: "T" },
      });

      const spawner = makeSpawner();
      const handle = spawner.spawn("tdd");
      expect(handle.sessionId).toBe("sess-123");
      expect(handle.style).toEqual({ label: "TDD", color: "cyan", badge: "T" });
    });

    it("alive getter delegates to AgentProcess", () => {
      let processAlive = true;
      mockedSpawnAgent.mockReturnValueOnce({
        send: vi.fn(),
        sendQuiet: vi.fn(),
        inject: vi.fn(),
        kill: vi.fn(),
        get alive() { return processAlive; },
        stderr: "hidden",
        sessionId: "sess-123",
        style: { label: "TDD", color: "", badge: "" },
      });

      const spawner = makeSpawner();
      const handle = spawner.spawn("tdd");
      expect(handle.alive).toBe(true);
      processAlive = false;
      expect(handle.alive).toBe(false);
    });

    it("exposes stderr from underlying process", () => {
      mockedSpawnAgent.mockReturnValueOnce({
        send: vi.fn(),
        sendQuiet: vi.fn(),
        inject: vi.fn(),
        kill: vi.fn(),
        pipe: vi.fn(),
        alive: true,
        stderr: "error output",
        sessionId: "sess-123",
        style: { label: "TDD", color: "", badge: "" },
      });

      const spawner = makeSpawner();
      const handle = spawner.spawn("tdd");
      expect(handle.stderr).toBe("error output");
    });

    it("delegates pipe to underlying AgentProcess", () => {
      const mockPipe = vi.fn();
      mockedSpawnAgent.mockReturnValueOnce({
        send: vi.fn(),
        sendQuiet: vi.fn(),
        inject: vi.fn(),
        kill: vi.fn(),
        pipe: mockPipe,
        alive: true,
        stderr: "",
        sessionId: "sess-123",
        style: { label: "TDD", color: "", badge: "" },
      });

      const spawner = makeSpawner();
      const handle = spawner.spawn("tdd");
      const onText = vi.fn();
      const onToolUse = vi.fn();
      handle.pipe(onText, onToolUse);
      expect(mockPipe).toHaveBeenCalledWith(onText, onToolUse);
    });
  });
});
