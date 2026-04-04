import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { expect, it } from "vitest";
import { RunOrchestration } from "#application/run-orchestration.js";
import { AGENT_DEFAULTS } from "#domain/agent-config.js";
import type { OrchestratorConfig, SkillSet } from "#domain/config.js";
import type { Group, Slice } from "#domain/plan.js";
import { ChildProcessGitOps } from "#infrastructure/child-process-git-ops.js";
import { resolveOrchrConfig } from "#infrastructure/config/orchrc.js";
import { loadTieredSkills } from "#infrastructure/skill-loader.js";
import { InkProgressSink, SilentOperatorGate } from "#ui/ink-operator-gate.js";
import { FakeAgentSpawner } from "./fakes/fake-agent-spawner.js";
import { FakeExecutionUnitTriager } from "./fakes/fake-execution-unit-triager.js";
import { FakeHud } from "./fakes/fake-hud.js";
import { FakeLogWriter } from "./fakes/fake-log-writer.js";
import { PassthroughPromptBuilder } from "./fakes/fake-prompt-builder.js";
import { FakeRolePromptResolver } from "./fakes/fake-role-prompt-resolver.js";
import { InMemoryStatePersistence } from "./fakes/fake-state-persistence.js";
import { okResult } from "./fakes/harness.js";

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

const DEFAULT_SKILLS: SkillSet = {
  tdd: "test",
  review: null,
  verify: null,
  plan: "test",
  gap: null,
  completeness: "test",
};

const addSmokeComment = (source: string): string => {
  const lines = source.split("\n");
  lines.splice(1, 0, "// smoke test");
  return lines.join("\n");
};

const removeSmokeComment = (source: string): string => {
  const lines = source.split("\n");
  if (lines[1] === "// smoke test") {
    lines.splice(1, 1);
  }
  return lines.join("\n");
};

const buildSmokePresenceTest = (): string => `import { readFile } from "fs/promises";
import { expect, it } from "vitest";

it("keeps src/main.ts with the smoke test comment on line 2", async () => {
  const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const secondLine = mainSource.split("\\n")[1] ?? "";

  expect(mainSource).toContain("\\n// smoke test\\n");
  expect(secondLine).toBe("// smoke test");
});
`;

const buildSmokeAbsenceTest = (): string => `import { readFile } from "fs/promises";
import { expect, it } from "vitest";

it("keeps src/main.ts without the smoke test comment on line 2", async () => {
  const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const secondLine = mainSource.split("\\n")[1] ?? "";

  expect(mainSource).not.toContain("\\n// smoke test\\n");
  expect(secondLine).not.toBe("// smoke test");
  expect(secondLine).not.toContain("smoke test");
});
`;

const runGit = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

class TempRepoSmokeScenario {
  readonly mainPath: string;
  readonly smokeTestPath: string;

  constructor(private readonly repoDir: string) {
    this.mainPath = join(repoDir, "src/main.ts");
    this.smokeTestPath = join(repoDir, "tests/smoke.test.ts");
  }

  seedFromWorkspace(): void {
    mkdirSync(join(this.repoDir, "src"), { recursive: true });
    mkdirSync(join(this.repoDir, "tests"), { recursive: true });
    writeFileSync(this.mainPath, readFileSync(join(process.cwd(), "src/main.ts"), "utf8"));

    runGit(this.repoDir, ["init"]);
    runGit(this.repoDir, ["config", "user.name", "Smoke Test"]);
    runGit(this.repoDir, ["config", "user.email", "smoke@example.com"]);
    runGit(this.repoDir, ["add", "src/main.ts"]);
    runGit(this.repoDir, ["commit", "-m", "Initial smoke baseline"]);
  }

  implementSmokeRequest(): void {
    const initialSource = readFileSync(this.mainPath, "utf8");
    expect(initialSource.split("\n")[1]).not.toBe("// smoke test");

    writeFileSync(this.mainPath, addSmokeComment(initialSource));
    writeFileSync(this.smokeTestPath, buildSmokePresenceTest());
    runGit(this.repoDir, ["add", "src/main.ts", "tests/smoke.test.ts"]);
    runGit(this.repoDir, ["commit", "-m", "Smoke slice 1"]);

    const sliceOneSource = readFileSync(this.mainPath, "utf8");
    expect(sliceOneSource.split("\n")[1]).toBe("// smoke test");

    writeFileSync(this.mainPath, removeSmokeComment(sliceOneSource));
    writeFileSync(this.smokeTestPath, buildSmokeAbsenceTest());
    runGit(this.repoDir, ["add", "src/main.ts", "tests/smoke.test.ts"]);
    runGit(this.repoDir, ["commit", "-m", "Smoke slice 2"]);
  }

  runMandatoryTestPass(): void {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { readFileSync } from "node:fs";

const mainSource = readFileSync("src/main.ts", "utf8");
const secondLine = mainSource.split("\\n")[1] ?? "";
if (mainSource.includes("\\n// smoke test\\n")) {
  throw new Error("smoke comment still present in final src/main.ts");
}
if (secondLine.includes("smoke test")) {
  throw new Error("line 2 still contains smoke test marker");
}

const testSource = readFileSync("tests/smoke.test.ts", "utf8");
if (!testSource.includes('not.toContain("\\\\n// smoke test\\\\n")')) {
  throw new Error("final smoke test does not assert comment absence");
}
if (!testSource.includes('not.toContain("smoke test")')) {
  throw new Error("final smoke test does not assert line-2 absence");
}
`,
      ],
      { cwd: this.repoDir, stdio: "pipe" },
    );
  }

  assertRequestDelivered(): void {
    const finalMainSource = readFileSync(this.mainPath, "utf8");
    const finalSecondLine = finalMainSource.split("\n")[1] ?? "";
    const finalSmokeTest = readFileSync(this.smokeTestPath, "utf8");
    const priorMainSource = runGit(this.repoDir, ["show", "HEAD~1:src/main.ts"]);
    const priorSecondLine = priorMainSource.split("\n")[1] ?? "";
    const priorSmokeTest = runGit(this.repoDir, ["show", "HEAD~1:tests/smoke.test.ts"]);

    expect(finalMainSource).not.toContain("\n// smoke test\n");
    expect(finalSecondLine).not.toContain("smoke test");
    expect(finalSmokeTest).toContain('not.toContain("\\n// smoke test\\n")');
    expect(priorSecondLine).toBe("// smoke test");
    expect(priorSmokeTest).toContain('expect(mainSource).toContain("\\n// smoke test\\n")');
    expect(priorSmokeTest).toContain('expect(secondLine).toBe("// smoke test")');
  }

  commitMessages(): string[] {
    return runGit(this.repoDir, ["log", "--format=%s", "-2"]).split("\n");
  }

  commitCount(): number {
    return Number(runGit(this.repoDir, ["rev-list", "--count", "HEAD"]));
  }
}

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

it("runs the direct smoke request against a temp repo with real file edits and git commits", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "orch-direct-smoke-"));
  const scenario = new TempRepoSmokeScenario(repoDir);
  const hud = new FakeHud();
  const spawner = new FakeAgentSpawner();
  const persistence = new InMemoryStatePersistence();
  const prompts = new PassthroughPromptBuilder();
  const logWriter = new FakeLogWriter();
  const rolePromptResolver = new FakeRolePromptResolver();
  const triager = new FakeExecutionUnitTriager();
  const config: OrchestratorConfig = {
    cwd: repoDir,
    planPath: join(repoDir, "plan.json"),
    planContent: DIRECT_SMOKE_REQUEST,
    brief: "brief",
    executionMode: "direct",
    executionPreference: "auto",
    auto: true,
    reviewThreshold: 30,
    maxReviewCycles: 3,
    stateFile: join(repoDir, "state.json"),
    logPath: null,
    tier: "medium",
    skills: DEFAULT_SKILLS,
    maxReplans: 3,
    defaultProvider: "claude",
    agentConfig: AGENT_DEFAULTS,
  };
  const uc = new RunOrchestration(
    spawner,
    persistence,
    new SilentOperatorGate(hud),
    new ChildProcessGitOps(repoDir),
    prompts,
    config,
    new InkProgressSink(hud),
    logWriter,
    rolePromptResolver,
    triager,
  );
  uc.retryDelayMs = 0;
  triager.queueResult({
    nextTier: "medium",
    completeness: "run_now",
    verify: "skip",
    review: "skip",
    gap: "skip",
    reason: "smoke boundary policy",
  });

  scenario.seedFromWorkspace();
  spawner.onNextSpawn(
    "tdd",
    () => {
      scenario.implementSmokeRequest();
      return okResult({ assistantText: "implemented both smoke slices" });
    },
    () => {
      scenario.runMandatoryTestPass();
      return okResult({ assistantText: "ran direct mandatory test pass" });
    },
  );
  spawner.onNextSpawn("completeness", () => {
    scenario.assertRequestDelivered();
    return okResult({ assistantText: "DIRECT_COMPLETE" });
  });

  try {
    await uc.execute([makeSmokeGroup()]);

    expect(scenario.commitCount()).toBe(3);
    expect(scenario.commitMessages()).toEqual(["Smoke slice 2", "Smoke slice 1"]);
    scenario.assertRequestDelivered();

    expect(persistence.current.executionMode).toBe("direct");
    expect(persistence.current.completedAt).toEqual(expect.any(String));
    expect(persistence.current.currentSlice).toBeUndefined();
    expect(persistence.current.lastCompletedSlice).toBeUndefined();
  } finally {
    uc.dispose();
    await rm(repoDir, { recursive: true, force: true });
  }
});
