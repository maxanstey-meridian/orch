import { describe, it, expect } from "vitest";
import { PlanSchema } from "@/plan/plan-schema.js";

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
