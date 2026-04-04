import { readFile } from "fs/promises";
import { join } from "path";
import { expect, it } from "vitest";

it("contains the smoke marker on line 2 of the main entrypoint", async () => {
  const mainPath = join(import.meta.dirname, "../src/main.ts");
  const mainSource = await readFile(mainPath, "utf8");
  const mainLines = mainSource.split("\n");

  expect(mainSource).toContain("// smoke test");
  expect(mainLines[1]).toBe("// smoke test");
});
