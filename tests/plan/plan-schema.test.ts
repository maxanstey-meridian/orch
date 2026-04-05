import { describe, it, expect } from "vitest";
import { PlanSchema, parsePlanJson, parsePlanDocumentJson } from "#infrastructure/plan/plan-schema.js";

describe("PlanSchema", () => {
  const validSlice = (number: number) => ({
    number,
    title: `Slice ${number}`,
    why: "Needed for feature X",
    files: [{ path: "src/foo.ts", action: "new" as const }],
    details: "Implement the thing",
    tests: "Test the thing",
  });

  const validGroup = (name: string, slices: Record<string, unknown>[]) => ({
    name,
    slices,
  });

  it("parses a minimal valid plan (one group, one slice)", () => {
    const input = { groups: [validGroup("Core", [validSlice(1)])] };
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it("accepts grouped execution mode metadata", () => {
    const input = {
      executionMode: "grouped",
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executionMode).toBe("grouped");
    }
  });

  it("accepts optional contextUpdates alongside context", () => {
    const input = {
      executionMode: "sliced",
      context: { architecture: "Clean Arch" },
      contextUpdates: { keyFiles: { "src/new.ts": "Newly discovered" } },
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextUpdates?.keyFiles?.["src/new.ts"]).toBe("Newly discovered");
    }
  });

  it("accepts non-empty criteria when present on a slice", () => {
    const input = {
      groups: [validGroup("Core", [{
        ...validSlice(1),
        criteria: ["Parser preserves criteria", "Rendered content includes criteria section"],
      }])],
    };

    const result = PlanSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups[0].slices[0].criteria).toEqual([
        "Parser preserves criteria",
        "Rendered content includes criteria section",
      ]);
    }
  });

  it("rejects plan missing required fields", () => {
    // missing groups entirely
    expect(PlanSchema.safeParse({}).success).toBe(false);

    // missing title on slice
    const noTitle = {
      groups: [{
        name: "G",
        slices: [{ number: 1, why: "w", files: [{ path: "a.ts", action: "new" }], details: "d", tests: "t" }],
      }],
    };
    expect(PlanSchema.safeParse(noTitle).success).toBe(false);

    // missing files on slice
    const noFiles = {
      groups: [{
        name: "G",
        slices: [{ number: 1, title: "S", why: "w", details: "d", tests: "t" }],
      }],
    };
    expect(PlanSchema.safeParse(noFiles).success).toBe(false);

    // missing why on slice
    const noWhy = {
      groups: [{
        name: "G",
        slices: [{ number: 1, title: "S", files: [{ path: "a.ts", action: "new" }], details: "d", tests: "t" }],
      }],
    };
    expect(PlanSchema.safeParse(noWhy).success).toBe(false);
  });


  it("rejects slice number 0", () => {
    const input = { groups: [validGroup("G", [validSlice(0)])] };
    expect(PlanSchema.safeParse(input).success).toBe(false);
  });

  it("rejects negative slice number", () => {
    const input = { groups: [validGroup("G", [validSlice(-1)])] };
    expect(PlanSchema.safeParse(input).success).toBe(false);
  });

  it("rejects float slice number", () => {
    const input = { groups: [validGroup("G", [validSlice(1.5)])] };
    expect(PlanSchema.safeParse(input).success).toBe(false);
  });

  it("rejects empty groups array", () => {
    expect(PlanSchema.safeParse({ groups: [] }).success).toBe(false);
  });

  it("rejects empty slices array", () => {
    const input = { groups: [{ name: "G", slices: [] }] };
    expect(PlanSchema.safeParse(input).success).toBe(false);
  });

  it("rejects empty files array", () => {
    const input = {
      groups: [validGroup("G", [{
        ...validSlice(1),
        files: [],
      }])],
    };
    expect(PlanSchema.safeParse(input).success).toBe(false);
  });

  it("rejects empty criteria array when criteria is present", () => {
    const input = {
      groups: [validGroup("G", [{
        ...validSlice(1),
        criteria: [],
      }])],
    };

    expect(PlanSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate slice numbers across groups", () => {
    const input = {
      groups: [
        validGroup("A", [validSlice(1)]),
        validGroup("B", [validSlice(1)]),
      ],
    };
    expect(PlanSchema.safeParse(input).success).toBe(false);
  });

  it("accepts distinct slice numbers across groups", () => {
    const input = {
      groups: [
        validGroup("A", [validSlice(1)]),
        validGroup("B", [validSlice(2)]),
      ],
    };
    expect(PlanSchema.safeParse(input).success).toBe(true);
  });

  it("rejects gapped slice numbers across groups", () => {
    const input = {
      groups: [
        validGroup("A", [validSlice(1)]),
        validGroup("B", [validSlice(3)]),
      ],
    };
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("sequential"))).toBe(true);
    }
  });

  it("rejects out-of-order slice numbers across groups", () => {
    const input = {
      groups: [
        validGroup("A", [validSlice(1), validSlice(3)]),
        validGroup("B", [validSlice(2)]),
      ],
    };
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("sequential"))).toBe(true);
    }
  });

  it("parses multi-group plan with optional description", () => {
    const input = {
      groups: [
        { ...validGroup("A", [validSlice(1), validSlice(2)]), description: "First group" },
        validGroup("B", [validSlice(3)]),
      ],
    };
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups[0].description).toBe("First group");
      expect(result.data.groups[1].description).toBeUndefined();
    }
  });
});

describe("parsePlanJson", () => {
  const makeJson = (obj: unknown) => JSON.stringify(obj);

  const validSlice = (number: number) => ({
    number,
    title: `Slice ${number}`,
    why: "Needed for feature X",
    files: [{ path: "src/foo.ts", action: "new" as const }],
    details: "Implement the thing",
    tests: "Test the thing",
  });

  const validGroup = (name: string, slices: Record<string, unknown>[]) => ({
    name,
    slices,
  });

  it("returns slices with structured fields", () => {
    const input = { groups: [validGroup("Core", [validSlice(1)])] };
    const groups = parsePlanJson(makeJson(input));
    const slice = groups[0].slices[0];
    expect(slice.why).toBe("Needed for feature X");
    expect(slice.files).toEqual([{ path: "src/foo.ts", action: "new" }]);
    expect(slice.details).toBe("Implement the thing");
    expect(slice.tests).toBe("Test the thing");
    expect(slice.number).toBe(1);
    expect(slice.title).toBe("Slice 1");
  });

  it("preserves slice criteria through parsePlanJson", () => {
    const input = {
      groups: [validGroup("Core", [{
        ...validSlice(1),
        criteria: ["Criteria one", "Criteria two"],
      }])],
    };

    const groups = parsePlanJson(makeJson(input));

    expect(groups[0].slices[0].criteria).toEqual(["Criteria one", "Criteria two"]);
  });

  it("computes content from structured fields", () => {
    const input = {
      groups: [validGroup("Core", [{
        number: 1,
        title: "Add logging",
        why: "Observability",
        files: [
          { path: "src/log.ts", action: "new" as const },
          { path: "src/app.ts", action: "edit" as const },
        ],
        details: "Create a logger module",
        tests: "Unit test the logger",
      }])],
    };
    const groups = parsePlanJson(makeJson(input));
    const content = groups[0].slices[0].content;
    expect(content).toContain("### Slice 1: Add logging");
    expect(content).toContain("**Why:** Observability");
    expect(content).toContain("`src/log.ts` (new)");
    expect(content).toContain("`src/app.ts` (edit)");
    expect(content).toContain("Create a logger module");
    expect(content).toContain("**Tests:** Unit test the logger");
  });

  it("handles multi-group plan with correct structure", () => {
    const input = {
      groups: [
        validGroup("Backend", [validSlice(1), validSlice(2)]),
        validGroup("Frontend", [validSlice(3), validSlice(4)]),
      ],
    };
    const groups = parsePlanJson(makeJson(input));
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("Backend");
    expect(groups[0].slices).toHaveLength(2);
    expect(groups[0].slices[0].number).toBe(1);
    expect(groups[0].slices[1].number).toBe(2);
    expect(groups[1].name).toBe("Frontend");
    expect(groups[1].slices).toHaveLength(2);
    expect(groups[1].slices[0].number).toBe(3);
    expect(groups[1].slices[1].number).toBe(4);
  });

  it("throws on invalid JSON with source identifier", () => {
    expect(() => parsePlanJson("{bad", "my-plan.json")).toThrow("my-plan.json");
  });

  it("throws on empty string", () => {
    expect(() => parsePlanJson("")).toThrow();
  });

  it("uses default source '<json>' in error when source arg is omitted", () => {
    expect(() => parsePlanJson("{bad")).toThrow("<json>");
  });

  it("surfaces Zod field path on validation error", () => {
    const input = {
      groups: [{
        name: "G",
        slices: [{ number: 1, title: "S", files: [{ path: "a.ts", action: "new" }], details: "d", tests: "t" }],
      }],
    };
    // missing "why" field
    expect(() => parsePlanJson(makeJson(input))).toThrow("why");
  });

  it("rejects duplicate slice numbers", () => {
    const input = {
      groups: [
        validGroup("A", [validSlice(1)]),
        validGroup("B", [validSlice(1)]),
      ],
    };
    expect(() => parsePlanJson(makeJson(input))).toThrow(/unique|duplicate/i);
  });

  it("rejects gapped slice numbers during parsing", () => {
    const input = {
      groups: [
        validGroup("A", [validSlice(1)]),
        validGroup("B", [validSlice(3)]),
      ],
    };
    expect(() => parsePlanJson(makeJson(input))).toThrow(/sequential/i);
  });

  it("rejects out-of-order slice numbers during parsing", () => {
    const input = {
      groups: [
        validGroup("A", [validSlice(1), validSlice(3)]),
        validGroup("B", [validSlice(2)]),
      ],
    };
    expect(() => parsePlanJson(makeJson(input))).toThrow(/sequential/i);
  });
});

describe("parsePlanDocumentJson", () => {
  const makeJson = (obj: unknown) => JSON.stringify(obj);

  const validSlice = (number: number) => ({
    number,
    title: `Slice ${number}`,
    why: "Needed for feature X",
    files: [{ path: "src/foo.ts", action: "new" as const }],
    details: "Implement the thing",
    tests: "Test the thing",
  });

  const validGroup = (name: string, slices: Record<string, unknown>[]) => ({
    name,
    slices,
  });

  const PLAN_CONTEXT = {
    architecture: "Clean Architecture with ports and adapters",
    keyFiles: { "src/main.ts": "Startup bootstrap" },
    concepts: { repoContext: "Canonical cross-run memory" },
    conventions: { testingBias: "Prefer seam-level tests" },
  };

  it("preserves top-level context when present", () => {
    const input = {
      executionMode: "sliced",
      context: PLAN_CONTEXT,
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const doc = parsePlanDocumentJson(makeJson(input));

    expect(doc.context).toEqual(PLAN_CONTEXT);
    expect(doc.context?.architecture).toBe("Clean Architecture with ports and adapters");
    expect(doc.context?.keyFiles?.["src/main.ts"]).toBe("Startup bootstrap");
    expect(doc.context?.concepts?.repoContext).toBe("Canonical cross-run memory");
    expect(doc.context?.conventions?.testingBias).toBe("Prefer seam-level tests");
  });

  it("returns undefined context when plan has no top-level context", () => {
    const input = {
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const doc = parsePlanDocumentJson(makeJson(input));

    expect(doc.context).toBeUndefined();
  });

  it("preserves both executionMode and groups alongside context", () => {
    const input = {
      executionMode: "grouped",
      context: { architecture: "Monolith" },
      groups: [validGroup("A", [validSlice(1)]), validGroup("B", [validSlice(2)])],
    };
    const doc = parsePlanDocumentJson(makeJson(input));

    expect(doc.executionMode).toBe("grouped");
    expect(doc.context?.architecture).toBe("Monolith");
    expect(doc.groups).toHaveLength(2);
    expect(doc.groups[0].slices[0].number).toBe(1);
  });

  it("round-trips context through JSON serialize and re-parse", () => {
    const input = {
      executionMode: "sliced",
      context: PLAN_CONTEXT,
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const doc = parsePlanDocumentJson(makeJson(input));
    // Re-serialize the validated plan doc and re-parse
    const reserialized = JSON.stringify({
      executionMode: doc.executionMode,
      context: doc.context,
      groups: doc.groups.map((g) => ({
        name: g.name,
        slices: g.slices.map((s) => ({
          number: s.number,
          title: s.title,
          why: s.why,
          files: s.files,
          details: s.details,
          tests: s.tests,
        })),
      })),
    });
    const reparsed = parsePlanDocumentJson(reserialized);

    expect(reparsed.context).toEqual(PLAN_CONTEXT);
  });

  it("preserves contextUpdates when present", () => {
    const updates = {
      architecture: "Discovered: hexagonal with event sourcing",
      keyFiles: { "src/events.ts": "Event bus entrypoint" },
    };
    const input = {
      executionMode: "sliced",
      context: PLAN_CONTEXT,
      contextUpdates: updates,
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const doc = parsePlanDocumentJson(makeJson(input));

    expect(doc.contextUpdates).toEqual(updates);
    expect(doc.context).toEqual(PLAN_CONTEXT);
  });

  it("returns undefined contextUpdates when absent", () => {
    const input = {
      executionMode: "sliced",
      context: PLAN_CONTEXT,
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const doc = parsePlanDocumentJson(makeJson(input));

    expect(doc.contextUpdates).toBeUndefined();
  });

  it("accepts plan with contextUpdates but no context", () => {
    const input = {
      contextUpdates: { concepts: { newConcept: "Discovered during planning" } },
      groups: [validGroup("Core", [validSlice(1)])],
    };
    const doc = parsePlanDocumentJson(makeJson(input));

    expect(doc.contextUpdates?.concepts?.newConcept).toBe("Discovered during planning");
    expect(doc.context).toBeUndefined();
  });
});
