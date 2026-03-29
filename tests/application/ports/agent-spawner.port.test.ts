import { describe, it, expect, vi } from "vitest";
import { AgentSpawner } from "../../../src/application/ports/agent-spawner.port.js";
import type { AgentHandle } from "../../../src/application/ports/agent-spawner.port.js";
import type { AgentStyle, AgentResult, AgentRole } from "../../../src/domain/agent-types.js";

describe("AgentHandle", () => {
  it("can be created as a mock object literal with all required fields", async () => {
    const style: AgentStyle = { label: "TDD", color: "green", badge: "T" };
    const result: AgentResult = {
      exitCode: 0,
      assistantText: "done",
      resultText: "ok",
      needsInput: false,
      sessionId: "sess-1",
    };

    const handle: AgentHandle = {
      sessionId: "sess-1",
      style,
      alive: true,
      send: vi.fn().mockResolvedValue(result),
      sendQuiet: vi.fn().mockResolvedValue("quiet response"),
      inject: vi.fn(),
      kill: vi.fn(),
    };

    expect(handle.sessionId).toBe("sess-1");
    expect(handle.style).toBe(style);
    expect(handle.alive).toBe(true);

    const sendResult = await handle.send("hello");
    expect(sendResult).toBe(result);

    const quietResult = await handle.sendQuiet("quiet");
    expect(quietResult).toBe("quiet response");

    handle.inject("injected");
    expect(handle.inject).toHaveBeenCalledWith("injected");

    handle.kill();
    expect(handle.kill).toHaveBeenCalled();
  });

  it("send accepts optional onText and onToolUse callbacks", async () => {
    const result: AgentResult = {
      exitCode: 0,
      assistantText: "done",
      resultText: "ok",
      needsInput: false,
      sessionId: "sess-1",
    };

    const handle: AgentHandle = {
      sessionId: "sess-1",
      style: { label: "TDD", color: "green", badge: "T" },
      alive: true,
      send: vi.fn().mockResolvedValue(result),
      sendQuiet: vi.fn().mockResolvedValue(""),
      inject: vi.fn(),
      kill: vi.fn(),
    };

    const onText = vi.fn();
    const onToolUse = vi.fn();
    await handle.send("test", onText, onToolUse);
    expect(handle.send).toHaveBeenCalledWith("test", onText, onToolUse);
  });
});

describe("AgentSpawner", () => {
  it("can be extended and spawn returns AgentHandle", () => {
    const style: AgentStyle = { label: "TDD", color: "green", badge: "T" };
    const mockResult: AgentResult = {
      exitCode: 0,
      assistantText: "",
      resultText: "",
      needsInput: false,
      sessionId: "sess-1",
    };

    const mockHandle: AgentHandle = {
      sessionId: "sess-1",
      style,
      alive: true,
      send: vi.fn().mockResolvedValue(mockResult),
      sendQuiet: vi.fn().mockResolvedValue(""),
      inject: vi.fn(),
      kill: vi.fn(),
    };

    class MockAgentSpawner extends AgentSpawner {
      spawn(_role: AgentRole, _opts?: { readonly resumeSessionId?: string }): AgentHandle {
        return mockHandle;
      }
    }

    const spawner = new MockAgentSpawner();
    const handle = spawner.spawn("tdd");
    expect(handle.sessionId).toBe("sess-1");
    expect(handle.alive).toBe(true);
  });

  it("spawn accepts optional opts parameter", () => {
    const mockHandle: AgentHandle = {
      sessionId: "resumed-sess",
      style: { label: "Review", color: "blue", badge: "R" },
      alive: true,
      send: vi.fn().mockResolvedValue({
        exitCode: 0,
        assistantText: "",
        resultText: "",
        needsInput: false,
        sessionId: "resumed-sess",
      }),
      sendQuiet: vi.fn().mockResolvedValue(""),
      inject: vi.fn(),
      kill: vi.fn(),
    };

    class MockAgentSpawner extends AgentSpawner {
      lastOpts: unknown;
      spawn(_role: AgentRole, opts?: { readonly resumeSessionId?: string; readonly systemPrompt?: string; readonly cwd?: string; readonly planMode?: boolean }): AgentHandle {
        this.lastOpts = opts;
        return mockHandle;
      }
    }

    const spawner = new MockAgentSpawner();
    const handle = spawner.spawn("review", { resumeSessionId: "abc", planMode: true });
    expect(handle.sessionId).toBe("resumed-sess");
    expect(spawner.lastOpts).toEqual({ resumeSessionId: "abc", planMode: true });
  });
});
