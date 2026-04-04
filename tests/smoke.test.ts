import { readFile } from "fs/promises";
import { join } from "path";
import { expect, it, vi } from "vitest";
import type { Group, Slice } from "#domain/plan.js";
import { resolveOrchrConfig } from "#infrastructure/config/orchrc.js";
import { loadTieredSkills } from "#infrastructure/skill-loader.js";
import { createTestHarness, okResult } from "./fakes/harness.js";

const DIRECT_SMOKE_REQUEST = `# Smoke Test

Two no-op slices to verify the orchestrator runs end-to-end.

## Slice 1 - Add smoke comment

- Edit src/main.ts: add the comment // smoke test on line 2.
- Write a test in tests/smoke.test.ts that reads src/main.ts and asserts the comment exists.

## Slice 2 - Remove smoke comment

- Edit src/main.ts: remove the // smoke test comment from line 2.
- Update the test in tests/smoke.test.ts to assert the comment is absent.
`;

const makeSmokeSlice = (): Slice => ({
  number: 1,
  title: "Smoke test",
  content: DIRECT_SMOKE_REQUEST,
  why: "Verify the direct request flow end-to-end.",
  files: [
    { path: "src/main.ts", action: "edit" },
    { path: "tests/smoke.test.ts", action: "edit" },
  ],
  details: "Exercise add/remove smoke marker behavior through the direct request flow.",
  tests: "Run the smoke test and require the final absence state.",
});

const makeSmokeGroup = (): Group => ({
  name: "Direct request",
  slices: [makeSmokeSlice()],
});

it("keeps src/main.ts without the smoke test comment on line 2", async () => {
  const mainPath = join(import.meta.dirname, "../src/main.ts");
  const mainSource = await readFile(mainPath, "utf8");
  const secondLine = mainSource.split("\n")[1] ?? "";

  expect(mainSource).not.toContain("\n// smoke test\n");
  expect(secondLine).not.toBe("// smoke test");
  expect(secondLine).not.toContain("smoke test");
});

it("does not reuse the review system prompt for completeness in tiered skill loading", () => {
  const orchrc = resolveOrchrConfig({}, process.cwd());
  const skills = loadTieredSkills("medium", orchrc);

  expect(skills.review).toEqual(expect.any(String));
  expect(skills.completeness).toBeNull();
});

it("proves the direct smoke request runs execute, commit, completeness fix, and final completion", async () => {
  const { uc, spawner, persistence, git } = createTestHarness({
    config: {
      executionMode: "direct",
      skills: { verify: null, review: "test", gap: null },
    },
    auto: true,
  });

  git.setDirty(true);
  git.setHasChanges(true);
  git.setDiffStats({ added: 50, removed: 0, total: 50 });
  git.getDiff = vi.fn().mockResolvedValue("diff --git a/src/main.ts b/src/main.ts");

  spawner.onNextSpawn(
    "tdd",
    okResult({ assistantText: "implemented both smoke slices" }),
    okResult({ assistantText: "ran direct mandatory test pass" }),
    okResult({ assistantText: "committed direct smoke request" }),
    okResult({ assistantText: "implemented the missing slice history" }),
    okResult({ assistantText: "committed direct smoke completeness fix" }),
  );
  spawner.onNextSpawn(
    "triage",
    okResult({
      assistantText: JSON.stringify({
        completeness: true,
        verify: false,
        review: false,
        gap: false,
        reason: "smoke completeness verification",
      }),
    }),
  );
  spawner.onNextSpawn(
    "completeness",
    okResult({
      assistantText: `❌ MISSING: Edit src/main.ts: add the comment // smoke test on line 2.
❌ MISSING: Write a test in tests/smoke.test.ts that reads src/main.ts and asserts the comment exists.`,
    }),
  );
  spawner.onNextSpawn("completeness", okResult({ assistantText: "DIRECT_COMPLETE" }));

  await uc.execute([makeSmokeGroup()]);

  const tdd = spawner.lastAgent("tdd");

  expect(tdd.sentPrompts).toHaveLength(5);
  expect(tdd.sentPrompts[0]).toContain("[DIRECT]");
  expect(tdd.sentPrompts[0]).toContain("Slice 1 - Add smoke comment");
  expect(tdd.sentPrompts[0]).toContain("Slice 2 - Remove smoke comment");
  expect(tdd.sentPrompts[1]).toContain("[DIRECT_TEST_PASS]");
  expect(tdd.sentPrompts[2]).toBe("[SWEEP] Direct request");
  expect(tdd.sentPrompts[3]).toContain(
    "A completeness check found that your implementation does not fully match the direct request.",
  );
  expect(tdd.sentPrompts[3]).toContain("## Completeness Findings");
  expect(tdd.sentPrompts[3]).toContain("MISSING");
  expect(tdd.sentPrompts[4]).toBe("[SWEEP] Direct request completeness fix");
  expect(tdd.quietPrompts).toContainEqual(
    expect.stringContaining("Summarise what you just built for the direct request"),
  );

  expect(spawner.agentsForRole("plan")).toHaveLength(0);
  expect(spawner.agentsForRole("triage")).toHaveLength(1);
  expect(spawner.agentsForRole("completeness")).toHaveLength(2);
  expect(spawner.agentsForRole("verify")).toHaveLength(0);
  expect(spawner.agentsForRole("review")).toHaveLength(1);
  expect(spawner.lastAgent("review").sentPrompts).toHaveLength(0);
  expect(spawner.agentsForRole("completeness")[0]?.sentPrompts[0]).toContain("Direct request");
  expect(spawner.agentsForRole("completeness")[0]?.sentPrompts[0]).toContain("DIRECT_COMPLETE");
  expect(spawner.agentsForRole("completeness")[1]?.sentPrompts[0]).toContain("Direct request");

  expect((persistence.current as Record<string, unknown>).executionMode).toBe("direct");
  expect((persistence.current as Record<string, unknown>).completedAt).toEqual(expect.any(String));
  expect(persistence.current.currentSlice).toBeUndefined();
  expect(persistence.current.lastCompletedSlice).toBeUndefined();
});
