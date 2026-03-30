import { describe, it, expect } from "vitest";
import { parseProviderFlag } from "../../src/infrastructure/cli/cli-args.js";

describe("parseProviderFlag", () => {
  it("returns claude when no --provider flag is present", () => {
    expect(parseProviderFlag([])).toBe("claude");
  });

  it("returns claude when --provider claude is passed", () => {
    expect(parseProviderFlag(["--provider", "claude"])).toBe("claude");
  });

  it("returns codex when --provider codex is passed", () => {
    expect(parseProviderFlag(["--provider", "codex"])).toBe("codex");
  });

  it("throws for an invalid provider value", () => {
    expect(() => parseProviderFlag(["--provider", "gemini"])).toThrow(
      /invalid provider.*claude.*codex/i,
    );
  });

  it("throws when --provider is at end of args with no value", () => {
    expect(() => parseProviderFlag(["--provider"])).toThrow(
      /--provider requires a value/i,
    );
  });

  it("throws when --provider is followed by another flag instead of a value", () => {
    expect(() => parseProviderFlag(["--provider", "--auto"])).toThrow(
      /--provider requires a value/i,
    );
  });
});
