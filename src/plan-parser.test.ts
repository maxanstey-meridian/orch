import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parsePlan } from "./plan-parser.js";

const withTempFile = async (content: string, fn: (path: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "orch-test-"));
  const path = join(dir, "plan.md");
  await writeFile(path, content);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true });
  }
};

describe("parsePlan", () => {
  it("throws when file does not exist", async () => {
    await expect(parsePlan("/nonexistent/plan.md")).rejects.toThrow();
  });

  it("throws when file contains no group headings", async () => {
    await withTempFile("# Just a title\n\nSome content.\n", async (path) => {
      await expect(parsePlan(path)).rejects.toThrow("No groups found");
    });
  });

  it("parses a single group with one slice", async () => {
    const content = [
      "## Group: Foundation",
      "",
      "### Slice 1: Plan Parsing",
      "",
      "Parse plan documents.",
      "",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result).toEqual([
        {
          name: "Foundation",
          slices: [
            {
              number: 1,
              title: "Plan Parsing",
              content: "### Slice 1: Plan Parsing\n\nParse plan documents.",
            },
          ],
        },
      ]);
    });
  });

  it("generates default title when slice heading has no title", async () => {
    const content = ["## Group: Core", "", "### Slice 3", "", "Some body."].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result[0].slices[0].title).toBe("Slice 3");
    });
  });

  it("preserves ordering of multiple slices within a group", async () => {
    const content = [
      "## Group: Build",
      "",
      "### Slice 1: First",
      "",
      "First body.",
      "",
      "### Slice 2: Second",
      "",
      "Second body.",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result).toHaveLength(1);
      expect(result[0].slices).toHaveLength(2);
      expect(result[0].slices[0].number).toBe(1);
      expect(result[0].slices[0].title).toBe("First");
      expect(result[0].slices[1].number).toBe(2);
      expect(result[0].slices[1].title).toBe("Second");
    });
  });

  it("associates slices with correct parent group across multiple groups", async () => {
    const content = [
      "## Group: Alpha",
      "",
      "### Slice 1: A1",
      "",
      "Alpha slice.",
      "",
      "## Group: Beta",
      "",
      "### Slice 2: B1",
      "",
      "Beta slice.",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Alpha");
      expect(result[0].slices).toHaveLength(1);
      expect(result[0].slices[0].number).toBe(1);
      expect(result[1].name).toBe("Beta");
      expect(result[1].slices).toHaveLength(1);
      expect(result[1].slices[0].number).toBe(2);
    });
  });

  it("treats malformed headings as content of preceding slice", async () => {
    const content = [
      "## Group: Core",
      "",
      "### Slice 1: Parser",
      "",
      "### Not a valid slice heading",
      "",
      "## Not a group (no Group: prefix)",
      "",
      "Still part of slice 1.",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result).toHaveLength(1);
      expect(result[0].slices).toHaveLength(1);
      expect(result[0].slices[0].content).toContain("### Not a valid slice heading");
      expect(result[0].slices[0].content).toContain("## Not a group (no Group: prefix)");
      expect(result[0].slices[0].content).toContain("Still part of slice 1.");
    });
  });

  it("strips trailing whitespace from slice content", async () => {
    const content = [
      "## Group: Core",
      "",
      "### Slice 1: Parser",
      "",
      "Body text.",
      "   ",
      "",
      "",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result[0].slices[0].content).toBe("### Slice 1: Parser\n\nBody text.");
    });
  });

  it('recognises "Phase" as alternative to "Slice" in headings', async () => {
    const content = [
      "## Group: Migration",
      "",
      "### Phase 1: Schema",
      "",
      "Run schema migration.",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result[0].slices[0]).toEqual({
        number: 1,
        title: "Schema",
        content: "### Phase 1: Schema\n\nRun schema migration.",
      });
    });
  });

  it("creates a group with no slices when consecutive group headings appear", async () => {
    const content = [
      "## Group: Empty",
      "",
      "## Group: HasSlice",
      "",
      "### Slice 1: Only",
      "",
      "Content.",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Empty");
      expect(result[0].slices).toHaveLength(0);
      expect(result[1].slices).toHaveLength(1);
    });
  });

  it("ignores slice headings that appear before any group heading", async () => {
    const content = [
      "### Slice 1: Orphan",
      "",
      "This slice has no group.",
      "",
      "## Group: Real",
      "",
      "### Slice 2: Attached",
      "",
      "This one has a group.",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Real");
      expect(result[0].slices).toHaveLength(1);
      expect(result[0].slices[0].number).toBe(2);
    });
  });

  it("parses a realistic plan with preamble, multiple groups, and mixed content", async () => {
    const content = [
      "# Feature Inventory",
      "",
      "Some preamble text that is not a group.",
      "",
      "## Group: Foundation — Pure Parsers",
      "",
      "### Slice 1: Plan Parsing",
      "",
      "#### Purpose",
      "Transforms a structured plan document.",
      "",
      "### Slice 2: Question Detection",
      "",
      "Detects questions in agent output.",
      "",
      "## Group: Infrastructure",
      "",
      "### Slice 3",
      "",
      "State persistence.",
    ].join("\n");

    await withTempFile(content, async (path) => {
      const result = await parsePlan(path);

      expect(result).toHaveLength(2);

      expect(result[0].name).toBe("Foundation — Pure Parsers");
      expect(result[0].slices).toHaveLength(2);
      expect(result[0].slices[0].number).toBe(1);
      expect(result[0].slices[0].title).toBe("Plan Parsing");
      expect(result[0].slices[0].content).toContain("#### Purpose");
      expect(result[0].slices[1].number).toBe(2);
      expect(result[0].slices[1].title).toBe("Question Detection");

      expect(result[1].name).toBe("Infrastructure");
      expect(result[1].slices).toHaveLength(1);
      expect(result[1].slices[0].number).toBe(3);
      expect(result[1].slices[0].title).toBe("Slice 3");
    });
  });
});
