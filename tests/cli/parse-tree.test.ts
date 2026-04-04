import { describe, expect, it } from "vitest";
import { parseTreeFlag } from "#infrastructure/cli/cli-args.js";

describe("parseTreeFlag", () => {
  it("returns the provided tree path when --tree has a value", () => {
    expect(parseTreeFlag(["--work", "plan.md", "--tree", "../repo-tree"])).toBe("../repo-tree");
  });

  it("returns undefined when --tree is not present", () => {
    expect(parseTreeFlag(["--work", "plan.md"])).toBeUndefined();
  });

  it("throws when --tree is the last argument", () => {
    expect(() => parseTreeFlag(["--plan", "inventory.md", "--tree"])).toThrow(
      "--tree requires a path value.",
    );
  });

  it("throws when the next token looks like another flag", () => {
    expect(() => parseTreeFlag(["--tree", "--quick"])).toThrow("--tree requires a path value.");
  });
});
