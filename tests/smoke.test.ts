import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("src/main.ts", () => {
  it("contains the smoke test comment on line 2", () => {
    const mainPath = resolve(import.meta.dirname, "..", "src", "main.ts");
    const lines = readFileSync(mainPath, "utf8").split("\n");

    expect(lines[1]).toBe("// smoke test");
  });
});
