import { describe, it, expect } from "vitest";
import { printStartupBanner } from "../../src/ui/display.js";

const collect = () => {
  const lines: string[] = [];
  const log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return { lines, log };
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("printStartupBanner", () => {
  const baseOpts = {
    planPath: "/repo/.orch/plan-abc123.md",
    brief: "Some context",
    auto: false,
    interactive: true,
    tddSessionId: "sess-tdd-12345678",
    reviewSessionId: "sess-rev-87654321",
    groups: [
      { name: "Auth", slices: [{ number: 1, title: "Login", content: "" }] },
      { name: "Dashboard", slices: [{ number: 2, title: "Widgets", content: "" }, { number: 3, title: "Charts", content: "" }] },
    ],
  };

  it("includes plan path in output", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    expect(text).toContain("plan-abc123.md");
  });

  it("shows green check when brief is truthy", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    expect(text).toContain(".orch/brief.md");
  });

  it("shows 'none' when brief is empty", () => {
    const { lines, log } = collect();
    printStartupBanner(log, { ...baseOpts, brief: "" });
    const text = strip(lines.join("\n"));
    expect(text).toContain("none");
  });

  it("shows 'automatic' mode when auto=true", () => {
    const { lines, log } = collect();
    printStartupBanner(log, { ...baseOpts, auto: true });
    const text = strip(lines.join("\n"));
    expect(text).toContain("automatic");
  });

  it("shows 'interactive' mode when auto=false", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    expect(text).toContain("interactive");
  });

  it("shows group filter in mode when specified", () => {
    const { lines, log } = collect();
    printStartupBanner(log, { ...baseOpts, groupFilter: "Auth" });
    const text = strip(lines.join("\n"));
    expect(text).toContain('start from "Auth"');
  });

  it("includes TDD and REVIEW session ID prefixes", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    expect(text).toContain("sess-tdd");
    expect(text).toContain("sess-rev");
  });

  it("includes group names in order", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    const authIdx = text.indexOf("Auth");
    const dashIdx = text.indexOf("Dashboard");
    expect(authIdx).toBeGreaterThan(-1);
    expect(dashIdx).toBeGreaterThan(authIdx);
  });

  it("marks the first group with bold marker", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = lines.join("\n");
    // The ▸ marker should appear before the first group
    expect(text).toContain("▸");
  });

  it("shows keyboard hint when interactive", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    expect(text).toContain("skip current slice");
  });

  it("hides keyboard hint when not interactive", () => {
    const { lines, log } = collect();
    printStartupBanner(log, { ...baseOpts, interactive: false });
    const text = strip(lines.join("\n"));
    expect(text).not.toContain("skip current slice");
  });

  it("shows worktree branch and path when worktree is provided", () => {
    const { lines, log } = collect();
    printStartupBanner(log, {
      ...baseOpts,
      worktree: { path: "/repo/.orch/trees/abc", branch: "orch/abc" },
    });
    const text = strip(lines.join("\n"));
    expect(text).toContain("orch/abc");
    expect(text).toContain("Worktree");
  });

  it("does not show Worktree line when worktree is undefined", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    expect(text).not.toContain("Worktree");
  });
});
