import { describe, it, expect } from "vitest";
import { parseBranchFlag } from "../../src/cli/cli-args.js";

describe("parseBranchFlag", () => {
  it("returns provided branch name when --branch has a value", () => {
    expect(parseBranchFlag(["--work", "plan.md", "--branch", "my-feature"], "abc123")).toBe(
      "my-feature",
    );
  });

  it("auto-generates orch/<planId> when --branch has no value", () => {
    expect(parseBranchFlag(["--work", "plan.md", "--branch"], "abc123")).toBe("orch/abc123");
  });

  it("auto-generates when next arg starts with dash", () => {
    expect(parseBranchFlag(["--branch", "--auto"], "abc123")).toBe("orch/abc123");
  });

  it("returns undefined when --branch not present", () => {
    expect(parseBranchFlag(["--work", "plan.md"], "abc123")).toBeUndefined();
  });

  it("auto-generates when --branch value is empty string", () => {
    expect(parseBranchFlag(["--branch", ""], "abc123")).toBe("orch/abc123");
  });
});
