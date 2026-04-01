import { describe, it, expect } from "vitest";
import { parseSubcommand } from "#infrastructure/cli/subcommands.js";

describe("parseSubcommand", () => {
  it("parses orch work plan.json as work command", () => {
    expect(parseSubcommand(["node", "orch", "work", "plan.json"])).toEqual({
      command: "work",
      planPath: "plan.json",
      flags: [],
    });
  });

  it("parses orch dash as dash command", () => {
    expect(parseSubcommand(["node", "orch", "dash"])).toEqual({
      command: "dash",
    });
  });

  it("parses orch status without id", () => {
    expect(parseSubcommand(["node", "orch", "status"])).toEqual({
      command: "status",
    });
  });

  it("parses orch status abc123 with id", () => {
    expect(parseSubcommand(["node", "orch", "status", "abc123"])).toEqual({
      command: "status",
      id: "abc123",
    });
  });

  it("parses orch status abc123 -f with follow", () => {
    expect(parseSubcommand(["node", "orch", "status", "abc123", "-f"])).toEqual({
      command: "status",
      id: "abc123",
      follow: true,
    });
  });

  it("parses orch queue add plan.json --auto", () => {
    expect(parseSubcommand(["node", "orch", "queue", "add", "plan.json", "--auto"])).toEqual({
      command: "queue",
      action: "add",
      planPath: "plan.json",
      flags: ["--auto"],
    });
  });

  it("parses orch queue list", () => {
    expect(parseSubcommand(["node", "orch", "queue", "list"])).toEqual({
      command: "queue",
      action: "list",
    });
  });

  it("parses orch queue remove abc123", () => {
    expect(parseSubcommand(["node", "orch", "queue", "remove", "abc123"])).toEqual({
      command: "queue",
      action: "remove",
      id: "abc123",
    });
  });

  it("parses orch plan inventory.md --auto", () => {
    expect(parseSubcommand(["node", "orch", "plan", "inventory.md", "--auto"])).toEqual({
      command: "plan",
      inventoryPath: "inventory.md",
      flags: ["--auto"],
    });
  });

  it("falls through to legacy for orch --work plan.json", () => {
    expect(parseSubcommand(["node", "orch", "--work", "plan.json"])).toEqual({
      command: "legacy",
      args: ["--work", "plan.json"],
    });
  });

  it("falls through to legacy for orch --plan inventory.md", () => {
    expect(parseSubcommand(["node", "orch", "--plan", "inventory.md"])).toEqual({
      command: "legacy",
      args: ["--plan", "inventory.md"],
    });
  });

  it("falls through to legacy for unknown subcommands", () => {
    expect(parseSubcommand(["node", "orch", "nonsense"])).toEqual({
      command: "legacy",
      args: ["nonsense"],
    });
  });

  it("does not treat -f as a status id", () => {
    expect(parseSubcommand(["node", "orch", "status", "-f"])).toEqual({
      command: "status",
      follow: true,
    });
  });

  it("falls through to legacy for queue without a supported action", () => {
    expect(parseSubcommand(["node", "orch", "queue"])).toEqual({
      command: "legacy",
      args: ["queue"],
    });
  });
});
