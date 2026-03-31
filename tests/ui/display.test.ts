import { describe, it, expect } from "vitest";
import { printStartupBanner, printSliceIntro, printSliceContent, formatPlanSummary } from "#ui/display.js";
import type { Slice } from "#infrastructure/plan/plan-parser.js";

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
      { name: "Auth", slices: [{ number: 1, title: "Login", content: "", why: "Auth needed", files: [{ path: "src/auth.ts", action: "new" as const }], details: "", tests: "" }] },
      { name: "Dashboard", slices: [{ number: 2, title: "Widgets", content: "", why: "", files: [{ path: "src/dash.ts", action: "new" as const }], details: "", tests: "" }, { number: 3, title: "Charts", content: "", why: "", files: [{ path: "src/charts.ts", action: "new" as const }], details: "", tests: "" }] },
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

  it("shows orchrc summary when provided", () => {
    const { lines, log } = collect();
    printStartupBanner(log, { ...baseOpts, orchrcSummary: "tdd: custom, review: disabled" });
    const text = strip(lines.join("\n"));
    expect(text).toContain("tdd: custom, review: disabled");
  });

  it("does not show Config line when orchrcSummary is undefined", () => {
    const { lines, log } = collect();
    printStartupBanner(log, baseOpts);
    const text = strip(lines.join("\n"));
    expect(text).not.toContain("Config");
  });
});

const makeSlice = (overrides: Partial<Slice> = {}) => ({
  number: 1,
  title: "User login",
  content: "",
  why: "Users need authentication before accessing resources",
  files: [{ path: "src/auth.ts", action: "new" as const }],
  details: "Implement login flow.",
  tests: "Login works.",
  ...overrides,
});

describe("printSliceIntro", () => {
  it("shows slice.why as the intro line", () => {
    const { lines, log } = collect();
    printSliceIntro(log, makeSlice());
    const text = strip(lines.join("\n"));
    expect(text).toContain("Users need authentication before accessing resources");
  });

  it("omits intro line when why is empty", () => {
    const { lines, log } = collect();
    printSliceIntro(log, makeSlice({ why: "" }));
    const stripped = lines.map(strip);
    // Should only have header and footer, no │ middle line
    expect(stripped).toHaveLength(2); // header and footer only
    expect(stripped.join("\n")).not.toContain("│  ");
  });

  it("formats intro line with dim ANSI codes", () => {
    const { lines, log } = collect();
    printSliceIntro(log, makeSlice({ why: "Test reason" }));
    const middleLine = lines.find((l) => l.includes("│  Test reason"));
    expect(middleLine).toBeDefined();
    expect(middleLine).toContain("\x1b[2m");  // dim
    expect(middleLine).toContain("\x1b[0m");  // reset
  });
});

describe("printSliceContent", () => {
  it("prints slice header and why", () => {
    const { lines, log } = collect();
    printSliceContent(log, makeSlice());
    const text = strip(lines.join("\n"));
    expect(text).toContain("Slice 1: User login");
    expect(text).toContain("Users need authentication before accessing resources");
  });

  it("prints files with path and action", () => {
    const { lines, log } = collect();
    printSliceContent(log, makeSlice());
    const text = strip(lines.join("\n"));
    expect(text).toContain("src/auth.ts");
    expect(text).toContain("new");
  });

  it("prints details and tests fields", () => {
    const { lines, log } = collect();
    printSliceContent(log, makeSlice());
    const text = strip(lines.join("\n"));
    expect(text).toContain("Implement login flow.");
    expect(text).toContain("Login works.");
  });

  it("handles slice with empty optional fields", () => {
    const { lines, log } = collect();
    printSliceContent(log, makeSlice({ why: "", tests: "", details: "" }));
    const text = strip(lines.join("\n"));
    expect(text).toContain("Slice 1: User login");
    expect(text).not.toContain("Details:");
    expect(text).not.toContain("Tests:");
  });

  it("omits Files header when files array is empty", () => {
    const { lines, log } = collect();
    printSliceContent(log, makeSlice({ files: [] }));
    const text = strip(lines.join("\n"));
    expect(text).toContain("Slice 1: User login");
    expect(text).not.toContain("Files:");
  });

  it("prints all files when multiple are present", () => {
    const { lines, log } = collect();
    printSliceContent(log, makeSlice({
      files: [
        { path: "src/a.ts", action: "new" },
        { path: "src/b.ts", action: "edit" },
        { path: "src/c.ts", action: "delete" },
      ],
    }));
    const text = strip(lines.join("\n"));
    expect(text).toContain("src/a.ts (new)");
    expect(text).toContain("src/b.ts (edit)");
    expect(text).toContain("src/c.ts (delete)");
  });
});

describe("formatPlanSummary", () => {
  const groups = [
    {
      name: "Auth",
      slices: [
        makeSlice({ number: 1, title: "Login", why: "Auth needed" }),
        makeSlice({ number: 2, title: "Session", why: "Persistence required" }),
      ],
    },
    {
      name: "Dashboard",
      slices: [
        makeSlice({ number: 3, title: "Widgets", why: "", content: "", tests: "Widget renders." }),
      ],
    },
  ];

  it("omits why line when why is empty", () => {
    const { lines, log } = collect();
    // Dashboard group has slice 3 with empty why
    const singleGroup = [{ name: "Test", slices: [makeSlice({ number: 1, why: "" })] }];
    formatPlanSummary(log, singleGroup);
    const text = strip(lines.join("\n"));
    // Should have group header, slice title, files, tests, footer — no blank why line
    expect(text).toContain("Slice 1:");
    expect(text).not.toMatch(/│\s*\n.*│\s*Files:/); // no empty line between title and files
  });

  it("prints tests summary", () => {
    const { lines, log } = collect();
    formatPlanSummary(log, groups);
    const text = strip(lines.join("\n"));
    expect(text).toContain("Login works.");
    expect(text).toContain("Widget renders.");
  });

  it("prints file paths with actions", () => {
    const { lines, log } = collect();
    formatPlanSummary(log, groups);
    const text = strip(lines.join("\n"));
    expect(text).toContain("src/auth.ts (new)");
  });

  it("prints why line for each slice", () => {
    const { lines, log } = collect();
    formatPlanSummary(log, groups);
    const text = strip(lines.join("\n"));
    expect(text).toContain("Auth needed");
    expect(text).toContain("Persistence required");
  });

  it("prints slice number and title", () => {
    const { lines, log } = collect();
    formatPlanSummary(log, groups);
    const text = strip(lines.join("\n"));
    expect(text).toContain("Slice 1: Login");
    expect(text).toContain("Slice 2: Session");
    expect(text).toContain("Slice 3: Widgets");
  });

  it("prints multiple files comma-separated", () => {
    const { lines, log } = collect();
    const multiFileGroups = [{
      name: "Multi",
      slices: [{
        number: 1,
        title: "Multi-file slice",
        content: "",
        why: "Need multiple files",
        files: [
          { path: "src/a.ts", action: "new" as const },
          { path: "src/b.ts", action: "edit" as const },
          { path: "src/c.ts", action: "delete" as const },
        ],
        details: "Details here.",
        tests: "Tests here.",
      }],
    }];
    formatPlanSummary(log, multiFileGroups);
    const text = strip(lines.join("\n"));
    expect(text).toContain("src/a.ts (new)");
    expect(text).toContain("src/b.ts (edit)");
    expect(text).toContain("src/c.ts (delete)");
  });

  it("prints group name as header", () => {
    const { lines, log } = collect();
    formatPlanSummary(log, groups);
    const text = strip(lines.join("\n"));
    const authIdx = text.indexOf("Auth");
    const dashIdx = text.indexOf("Dashboard");
    expect(authIdx).toBeGreaterThan(-1);
    expect(dashIdx).toBeGreaterThan(authIdx);
  });
});
