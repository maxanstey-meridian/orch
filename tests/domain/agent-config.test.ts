import { describe, it, expect } from "vitest";
import { parseAgentConfigValue, AGENT_DEFAULTS, resolveAgentConfig, resolveAllAgentConfigs } from "#domain/agent-config.js";
import { AGENT_ROLES } from "#domain/agent-types.js";

describe("parseAgentConfigValue", () => {
  it("parses bare claude provider", () => {
    expect(parseAgentConfigValue("claude")).toEqual({ provider: "claude" });
  });

  it("parses bare codex provider", () => {
    expect(parseAgentConfigValue("codex")).toEqual({ provider: "codex" });
  });

  it("parses claude:opus", () => {
    expect(parseAgentConfigValue("claude:opus")).toEqual({
      provider: "claude",
      model: "claude-opus-4-20250514",
    });
  });

  it("parses claude:sonnet", () => {
    expect(parseAgentConfigValue("claude:sonnet")).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-20250514",
    });
  });

  it("parses claude:haiku", () => {
    expect(parseAgentConfigValue("claude:haiku")).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("throws on codex:opus (codex has no model support)", () => {
    expect(() => parseAgentConfigValue("codex:opus")).toThrow("Invalid agent config value");
  });

  it("throws on invalid provider", () => {
    expect(() => parseAgentConfigValue("invalid")).toThrow("Invalid agent config value");
  });

  it("throws on unknown claude model alias", () => {
    expect(() => parseAgentConfigValue("claude:unknown")).toThrow("Invalid agent config value");
  });
});

describe("AGENT_DEFAULTS", () => {
  it("has an entry for every AgentRole", () => {
    for (const role of AGENT_ROLES) {
      expect(AGENT_DEFAULTS).toHaveProperty(role);
      expect(AGENT_DEFAULTS[role].provider).toBe("claude");
    }
  });
});

describe("resolveAgentConfig", () => {
  it("returns agents entry when present", () => {
    expect(resolveAgentConfig("tdd", { tdd: "codex" }, "claude")).toEqual({
      provider: "codex",
    });
  });

  it("returns agents entry with model when present", () => {
    expect(resolveAgentConfig("plan", { plan: "claude:opus" }, "claude")).toEqual({
      provider: "claude",
      model: "claude-opus-4-20250514",
    });
  });

  it("falls back to cliProvider when no agents entry and cliProvider is not claude", () => {
    expect(resolveAgentConfig("tdd", undefined, "codex")).toEqual({ provider: "codex" });
    expect(resolveAgentConfig("tdd", {}, "codex")).toEqual({ provider: "codex" });
  });

  it("returns default when cliProvider is claude and no agents entry", () => {
    expect(resolveAgentConfig("tdd", undefined, "claude")).toEqual({ provider: "claude" });
  });
});

describe("resolveAllAgentConfigs", () => {
  it("resolves all 8 roles with defaults", () => {
    const result = resolveAllAgentConfigs(undefined, "claude");
    expect(Object.keys(result)).toHaveLength(AGENT_ROLES.length);
    for (const role of AGENT_ROLES) {
      expect(result[role]).toEqual(AGENT_DEFAULTS[role]);
    }
  });

  it("applies per-role overrides", () => {
    const result = resolveAllAgentConfigs({ tdd: "codex", plan: "claude:opus" }, "claude");
    expect(result.tdd).toEqual({ provider: "codex" });
    expect(result.plan).toEqual({ provider: "claude", model: "claude-opus-4-20250514" });
    expect(result.review).toEqual({ provider: "claude" });
  });
});
