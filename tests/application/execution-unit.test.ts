import { describe, expect, it } from "vitest";
import { buildContent, type Group, type Slice } from "#domain/plan.js";
import { directUnit, groupedUnit, sliceUnit } from "#application/execution-unit.js";

const makeSlice = (number: number, overrides?: Partial<Slice>): Slice => ({
  number,
  title: `Slice ${number}`,
  content: `raw content for ${number}`,
  why: `reason ${number}`,
  files: [{ path: `src/slice-${number}.ts`, action: "new" }],
  details: `details ${number}`,
  tests: `tests ${number}`,
  ...overrides,
});

const makeGroup = (name: string, slices: readonly Slice[]): Group => ({
  name,
  slices,
});

describe("execution-unit factories", () => {
  it("sliceUnit creates a slice execution unit using rendered slice content", () => {
    const slice = makeSlice(3, { content: "raw-only-body" });

    const unit = sliceUnit(slice, "G1");

    expect(unit.kind).toBe("slice");
    expect(unit.label).toBe("Slice 3");
    expect(unit.sliceNumber).toBe(3);
    expect(unit.groupName).toBe("G1");
    expect(unit.slices).toEqual([slice]);
    expect(unit.content).toBe(buildContent(slice));
    expect(unit.content).not.toBe(slice.content);
  });

  it("groupedUnit creates a group execution unit with all slice bodies separated by dividers", () => {
    const first = makeSlice(1, { title: "First", content: "alpha" });
    const second = makeSlice(2, { title: "Second", content: "beta" });

    const unit = groupedUnit(makeGroup("Core", [first, second]));

    expect(unit.kind).toBe("group");
    expect(unit.label).toBe("Group Core");
    expect(unit.groupName).toBe("Core");
    expect(unit.sliceNumber).toBe(2);
    expect(unit.slices).toEqual([first, second]);
    expect(unit.content).toBe(
      "### Slice 1: First\n\nalpha\n\n---\n\n### Slice 2: Second\n\nbeta",
    );
  });

  it("directUnit creates a direct execution unit", () => {
    const unit = directUnit("request text", 7);

    expect(unit.kind).toBe("direct");
    expect(unit.label).toBe("Direct request");
    expect(unit.content).toBe("request text");
    expect(unit.sliceNumber).toBe(7);
    expect(unit.groupName).toBe("Direct");
    expect(unit.slices).toEqual([]);
  });
});
