import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchrConfigLoader } from "#infrastructure/config/orchrc-loader.js";

describe("OrchrConfigLoader", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orch-orchrc-loader-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads raw .orchrc.json content", async () => {
    await writeFile(
      join(tempDir, ".orchrc.json"),
      JSON.stringify({
        config: { maxReviewCycles: 4 },
        worktreeSetup: ["pnpm install"],
      }),
    );

    const loader = new OrchrConfigLoader(tempDir);

    expect(loader.load()).toEqual({
      config: { maxReviewCycles: 4 },
      worktreeSetup: ["pnpm install"],
    });
  });

  it("resolves file-backed config and produces a summary", async () => {
    await writeFile(join(tempDir, "review.md"), "custom review skill");
    await writeFile(join(tempDir, "tdd-rules.md"), "rule one");
    await writeFile(
      join(tempDir, ".orchrc.json"),
      JSON.stringify({
        skills: { review: "./review.md" },
        rules: { tdd: "./tdd-rules.md" },
        config: { maxReviewCycles: 5, reviewThreshold: 0 },
        agents: { tdd: "codex" },
        worktreeSetup: ["pnpm install", "pnpm build"],
      }),
    );

    const loader = new OrchrConfigLoader(tempDir);
    const resolved = loader.loadResolved();

    expect(resolved.skills.review).toEqual({ content: "custom review skill" });
    expect(resolved.rules.tdd).toBe("rule one");
    expect(resolved.config).toEqual({ maxReviewCycles: 5, reviewThreshold: 0 });
    expect(resolved.agents).toEqual({ tdd: "codex" });
    expect(resolved.worktreeSetup).toEqual(["pnpm install", "pnpm build"]);
    expect(loader.buildSummary(resolved)).toBe(
      "review: custom, maxReviewCycles: 5, reviewThreshold: 0, tdd: codex",
    );
  });

  it("resolves an explicit raw config object", async () => {
    await writeFile(join(tempDir, "gap.md"), "gap prompt");

    const loader = new OrchrConfigLoader(tempDir);
    const resolved = loader.resolve({
      skills: { gap: "./gap.md" },
      worktreeSetup: ["pnpm install"],
    });

    expect(resolved.skills.gap).toEqual({ content: "gap prompt" });
    expect(resolved.worktreeSetup).toEqual(["pnpm install"]);
  });
});
