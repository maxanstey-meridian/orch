import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parsePlan, parsePlanDocument } from "#infrastructure/plan/plan-parser.js";

const withTempFile = async (content: string, fn: (path: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "orch-test-"));
  const path = join(dir, "plan.json");
  await writeFile(path, content);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true });
  }
};

const validSlice = (n: number) => ({
  number: n,
  title: `Slice ${n}`,
  why: "Because",
  files: [{ path: "src/foo.ts", action: "new" }],
  details: "Do the thing",
  tests: "Test it",
});

const validPlan = (slices?: ReturnType<typeof validSlice>[]) => ({
  groups: [{ name: "Core", slices: slices ?? [validSlice(1)] }],
});

describe("parsePlan", () => {
  it("parses valid JSON plan with required structured fields", async () => {
    await withTempFile(JSON.stringify(validPlan()), async (path) => {
      const result = await parsePlan(path);
      const slice = result[0].slices[0];
      expect(slice.why).toBe("Because");
      expect(slice.files).toEqual([{ path: "src/foo.ts", action: "new" }]);
      expect(slice.details).toBe("Do the thing");
      expect(slice.tests).toBe("Test it");
      expect(slice.number).toBe(1);
      expect(slice.title).toBe("Slice 1");
    });
  });

  it("rejects non-JSON content", async () => {
    await withTempFile("## Group: Core\n### Slice 1: Foo\nBody", async (path) => {
      await expect(parsePlan(path)).rejects.toThrow();
    });
  });

  it("surfaces Zod validation errors for missing fields", async () => {
    const invalid = {
      groups: [{
        name: "G",
        slices: [{ number: 1, title: "S", files: [{ path: "a.ts", action: "new" }], details: "d", tests: "t" }],
      }],
    };
    await withTempFile(JSON.stringify(invalid), async (path) => {
      await expect(parsePlan(path)).rejects.toThrow("why");
    });
  });

  it("handles multi-group JSON", async () => {
    const plan = {
      groups: [
        { name: "Backend", slices: [validSlice(1), validSlice(2)] },
        { name: "Frontend", slices: [validSlice(3), validSlice(4)] },
      ],
    };
    await withTempFile(JSON.stringify(plan), async (path) => {
      const result = await parsePlan(path);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Backend");
      expect(result[0].slices).toHaveLength(2);
      expect(result[1].name).toBe("Frontend");
      expect(result[1].slices).toHaveLength(2);
      for (const group of result) {
        for (const slice of group.slices) {
          expect(slice.why).toBeDefined();
          expect(slice.files).toBeDefined();
          expect(slice.details).toBeDefined();
          expect(slice.tests).toBeDefined();
        }
      }
    });
  });

  it("throws on missing file", async () => {
    await expect(parsePlan("/nonexistent/plan.json")).rejects.toThrow();
  });
});

describe("parsePlanDocument", () => {
  const PLAN_CONTEXT = {
    architecture: "Clean Architecture",
    keyFiles: { "src/main.ts": "Bootstrap entrypoint" },
    concepts: { planContext: "Structured plan-local knowledge" },
    conventions: { testingBias: "Seam-level tests" },
  };

  it("returns full document with context when present", async () => {
    const plan = {
      executionMode: "sliced",
      context: PLAN_CONTEXT,
      groups: [{ name: "Core", slices: [validSlice(1)] }],
    };
    await withTempFile(JSON.stringify(plan), async (path) => {
      const doc = await parsePlanDocument(path);

      expect(doc.executionMode).toBe("sliced");
      expect(doc.context).toEqual(PLAN_CONTEXT);
      expect(doc.groups).toHaveLength(1);
      expect(doc.groups[0].slices[0].number).toBe(1);
    });
  });

  it("returns undefined context when plan has none", async () => {
    await withTempFile(JSON.stringify(validPlan()), async (path) => {
      const doc = await parsePlanDocument(path);

      expect(doc.context).toBeUndefined();
      expect(doc.groups).toHaveLength(1);
    });
  });

  it("parsePlan still returns groups only (backward compat)", async () => {
    const plan = {
      executionMode: "sliced",
      context: PLAN_CONTEXT,
      groups: [{ name: "Core", slices: [validSlice(1)] }],
    };
    await withTempFile(JSON.stringify(plan), async (path) => {
      const groups = await parsePlan(path);

      // parsePlan returns Group[], not PlanDocument
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe("Core");
      // No context property on groups array
      expect((groups as unknown as Record<string, unknown>).context).toBeUndefined();
    });
  });
});
