import { describe, it, expect } from "vitest";
import { buildContent } from "../../src/domain/plan.js";

describe("buildContent", () => {
  it("produces expected markdown for a single-file slice", () => {
    const result = buildContent({
      number: 1,
      title: "Add feature",
      why: "Needed",
      files: [{ path: "src/foo.ts", action: "new" }],
      details: "Implement it.",
      tests: "Test it.",
    });

    expect(result).toContain("### Slice 1: Add feature");
    expect(result).toContain("**Why:** Needed");
    expect(result).toContain("`src/foo.ts` (new)");
    expect(result).toContain("Implement it.");
    expect(result).toContain("**Tests:** Test it.");
  });

  it("produces comma-separated file list for multiple files", () => {
    const result = buildContent({
      number: 2,
      title: "Multi file",
      why: "Because",
      files: [
        { path: "src/a.ts", action: "new" },
        { path: "src/b.ts", action: "edit" },
      ],
      details: "Details.",
      tests: "Tests.",
    });

    expect(result).toContain("`src/a.ts` (new), `src/b.ts` (edit)");
  });

  it("renders delete file action correctly", () => {
    const result = buildContent({
      number: 3,
      title: "Remove old",
      why: "Cleanup",
      files: [{ path: "src/old.ts", action: "delete" }],
      details: "Remove it.",
      tests: "Verify removed.",
    });

    expect(result).toContain("`src/old.ts` (delete)");
  });

  it("renders empty files array as empty file list", () => {
    const result = buildContent({
      number: 4,
      title: "No files",
      why: "Edge case",
      files: [],
      details: "Details.",
      tests: "Tests.",
    });

    expect(result).toContain("**Files:** \n");
  });
});
