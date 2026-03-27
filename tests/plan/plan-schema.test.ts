import { describe, it, expect } from "vitest";
import { PlanSchema, parsePlanJson } from "@/plan/plan-schema.js";

describe("PlanSchema", () => {
  const validSlice = (number: number) => ({
    number,
    title: `Slice ${number}`,
    why: "Needed for feature X",
    files: [{ path: "src/foo.ts", action: "new" as const }],
    details: "Implement the thing",
    tests: "Test the thing",
  });

  const validGroup = (name: string, slices: ReturnType<typeof validSlice>[]) => ({
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

  it("rejects invalid file action", () => {
    const input = {
      groups: [validGroup("G", [{
        ...validSlice(1),
        files: [{ path: "x.ts", action: "rename" }],
      }])],
    };
    expect(PlanSchema.safeParse(input).success).toBe(false);
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

  const validGroup = (name: string, slices: ReturnType<typeof validSlice>[]) => ({
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

  it("computes content from structured fields", () => {
    const input = {
      groups: [validGroup("Core", [{
        number: 2,
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
    expect(content).toContain("### Slice 2: Add logging");
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
});
