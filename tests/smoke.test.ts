import { readFile } from "fs/promises";
import { join } from "path";
import { expect, it } from "vitest";

it("contains the smoke marker in the main entrypoint header", async () => {
  const mainPath = join(import.meta.dirname, "../src/main.ts");
  const mainSource = await readFile(mainPath, "utf8");

  expect(mainSource).toContain("// smoke test");
});
