import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { extractJson, planSummaryLines, generatePlan, isPlanFormat, planFileName, planIdFromPath, generatePlanId, resolvePlanId, ensureCanonicalPlan, doGeneratePlan } from "../../src/infrastructure/plan/plan-generator.js";
import { PlanSchema, parsePlanJson } from "../../src/infrastructure/plan/plan-schema.js";
import type { AgentHandle } from "../../src/application/ports/agent-spawner.port.js";
import type { AgentResult } from "../../src/domain/agent-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_PLAN = JSON.stringify({
  groups: [
    {
      name: "Auth",
      slices: [
        { number: 1, title: "User login", why: "Users need to log in.", files: [{ path: "src/auth.ts", action: "new" }], details: "Implement login flow.", tests: "Login works." },
        { number: 2, title: "Token refresh", why: "Tokens expire.", files: [{ path: "src/auth.ts", action: "edit" }], details: "Implement token refresh.", tests: "Refresh works." },
      ],
    },
    {
      name: "Dashboard",
      slices: [
        { number: 3, title: "Widget rendering", why: "Users need widgets.", files: [{ path: "src/dashboard.ts", action: "new" }], details: "Render widgets.", tests: "Widgets render." },
      ],
    },
  ],
});

const PLAN_WITH_PREAMBLE = `Here's the plan I generated:\n${VALID_PLAN}\nLet me know if you'd like changes.`;

const mockAgent = (responseText: string): Pick<AgentHandle, 'send' | 'kill'> => ({
  send: async (_prompt: string) =>
    ({
      exitCode: 0,
      assistantText: responseText,
      resultText: "",
      needsInput: false,
      sessionId: "mock",
    }) as AgentResult,
  kill: () => {},
});

// ─── planFileName ───────────────────────────────────────────────────────────

describe("planFileName", () => {
  it("returns plan-<id>.json for a given hex id", () => {
    expect(planFileName("a1b2c3")).toBe("plan-a1b2c3.json");
  });
});

// ─── planIdFromPath ─────────────────────────────────────────────────────────

describe("planIdFromPath", () => {
  it("extracts the 6-char hex id from a valid plan path", () => {
    expect(planIdFromPath("/foo/.orch/plan-a1b2c3.json")).toBe("a1b2c3");
  });

  it("throws when filename does not match plan-<hex>.json pattern", () => {
    expect(() => planIdFromPath("/foo/random.json")).toThrow("Cannot extract plan ID");
  });

  it("throws for uppercase hex in filename", () => {
    expect(() => planIdFromPath("/foo/.orch/plan-A1B2C3.json")).toThrow("Cannot extract plan ID");
  });

  it("throws for too-short hex (5 chars)", () => {
    expect(() => planIdFromPath("/foo/.orch/plan-a1b2c.json")).toThrow("Cannot extract plan ID");
  });

  it("throws for too-long hex (7 chars)", () => {
    expect(() => planIdFromPath("/foo/.orch/plan-a1b2c3d.json")).toThrow("Cannot extract plan ID");
  });

  it("throws for .md paths (no longer matches)", () => {
    expect(() => planIdFromPath("/foo/.orch/plan-a1b2c3.md")).toThrow("Cannot extract plan ID");
  });
});

// ─── generatePlanId ─────────────────────────────────────────────────────────

describe("generatePlanId", () => {
  it("returns a 6-char hex string", () => {
    const id = generatePlanId();
    expect(id).toMatch(/^[0-9a-f]{6}$/);
  });

  it("produces distinct values across multiple calls", () => {
    const ids = Array.from({ length: 10 }, () => generatePlanId());
    const unique = new Set(ids);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});

// ─── resolvePlanId ──────────────────────────────────────────────────────────

describe("resolvePlanId", () => {
  it("extracts ID from a plan-<id>.json path via regex", () => {
    expect(resolvePlanId("/repo/.orch/plan-a1b2c3.json")).toBe("a1b2c3");
  });

  it("returns a 6-char hex string for an arbitrary path (hash fallback)", () => {
    expect(resolvePlanId("/repo/plan.md")).toMatch(/^[0-9a-f]{6}$/);
  });

  it("is deterministic — same path always produces same ID", () => {
    const id1 = resolvePlanId("/repo/plan.md");
    const id2 = resolvePlanId("/repo/plan.md");
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different paths", () => {
    const idA = resolvePlanId("/repo/plan-a.md");
    const idB = resolvePlanId("/repo/plan-b.md");
    expect(idA).not.toBe(idB);
  });
});

// ─── ensureCanonicalPlan ────────────────────────────────────────────────────

describe("ensureCanonicalPlan", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canonical-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("copies non-standard plan to orchDir/plan-<id>.json and returns the plan ID", () => {
    const planPath = join(tmpDir, "plan.md");
    const orchDir = join(tmpDir, ".orch");
    writeFileSync(planPath, "## Group: Test\n### Slice 1: Noop\nDo nothing.");

    const id = ensureCanonicalPlan(planPath, orchDir);

    expect(id).toMatch(/^[0-9a-f]{6}$/);
    const canonical = readFileSync(join(orchDir, `plan-${id}.json`), "utf-8");
    expect(canonical).toContain("## Group: Test");
  });

  it("does not overwrite an existing canonical file", () => {
    const planPath = join(tmpDir, "plan.md");
    const orchDir = join(tmpDir, ".orch");
    writeFileSync(planPath, "new content");

    // First call creates
    const id = ensureCanonicalPlan(planPath, orchDir);
    // Overwrite the canonical with different content
    writeFileSync(join(orchDir, `plan-${id}.json`), "original");

    // Second call should NOT overwrite
    ensureCanonicalPlan(planPath, orchDir);
    const content = readFileSync(join(orchDir, `plan-${id}.json`), "utf-8");
    expect(content).toBe("original");
  });

  it("returns regex-extracted ID for plan-<id>.json paths without copying", () => {
    const orchDir = join(tmpDir, ".orch");
    mkdirSync(orchDir, { recursive: true });
    const planPath = join(orchDir, "plan-a1b2c3.json");
    writeFileSync(planPath, "## Group: Test");

    const id = ensureCanonicalPlan(planPath, orchDir);
    expect(id).toBe("a1b2c3");
  });
});

// ─── extractJson ───────────────────────────────────────────────────────────

describe("extractJson", () => {
  it("extracts JSON object from text with preamble and postamble", () => {
    const input = `Here's the plan:\n{"groups":[{"name":"A","slices":[]}]}\nLet me know.`;
    expect(extractJson(input)).toBe('{"groups":[{"name":"A","slices":[]}]}');
  });

  it("returns original text when no braces found", () => {
    expect(extractJson("no json here")).toBe("no json here");
  });

  it("handles nested braces correctly", () => {
    const json = '{"groups":[{"name":"A","slices":[{"number":1}]}]}';
    const input = `preamble\n${json}\npostamble`;
    expect(extractJson(input)).toBe(json);
  });

  it("returns empty string for empty input", () => {
    expect(extractJson("")).toBe("");
  });

  it("handles stray } before the JSON object", () => {
    const input = 'some text } preamble {"groups":[]} end';
    const result = extractJson(input);
    // Extracts from first { to last } — may span the stray }, but result includes the valid object
    expect(result).toContain('{"groups":[]}');
  });

  it("finds valid JSON when multiple objects exist in text", () => {
    const input = 'example: {"a":1} real plan: {"groups":[]}';
    const result = extractJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// ─── isPlanFormat ───────────────────────────────────────────────────────────

describe("isPlanFormat", () => {
  it("returns true for valid JSON plan with groups array", () => {
    const json = JSON.stringify({ groups: [{ name: "Auth", slices: [] }] });
    expect(isPlanFormat(json)).toBe(true);
  });

  it("returns false for inventory markdown", () => {
    const inventory = "# Feature Inventory\n\n## Login\nUsers can log in.";
    expect(isPlanFormat(inventory)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPlanFormat("")).toBe(false);
  });

  it("returns false for JSON without groups key", () => {
    expect(isPlanFormat(JSON.stringify({ slices: [] }))).toBe(false);
  });

  it("returns false for JSON where groups is not an array", () => {
    expect(isPlanFormat(JSON.stringify({ groups: "not-array" }))).toBe(false);
  });
});

// ─── generatePlan ───────────────────────────────────────────────────────────

describe("generatePlan", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "plangen-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes plan to plan-<id>.json and returns planPath and planId", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nUsers can log in.\n\n## Dashboard\nWidgets.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const result = await generatePlan(inventoryPath, "Brief content here", agent, outputDir);

    expect(result.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(result.planPath).toBe(join(outputDir, `plan-${result.planId}.json`));
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].name).toBe("Auth");
    expect(result.groups[0].slices).toHaveLength(2);
    expect(result.groups[1].name).toBe("Dashboard");
    const written = readFileSync(result.planPath, "utf-8");
    expect(written).toContain('"Auth"');
    expect(written).toContain('"User login"');
  });

  it("strips preamble from agent response", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nLogin feature.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(PLAN_WITH_PREAMBLE);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    expect(written).toContain('"groups"');
    expect(written).not.toContain("Here's the plan");
  });

  it("generated plan passes Zod validation", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    const parsed = PlanSchema.parse(JSON.parse(written));
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0].name).toBe("Auth");
    expect(parsed.groups[0].slices).toHaveLength(2);
    expect(parsed.groups[1].name).toBe("Dashboard");
    expect(parsed.groups[1].slices).toHaveLength(1);
  });

  it("prefers planText from ExitPlanMode over assistantText", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent: Pick<AgentHandle, 'send'> = {
      send: async () =>
        ({
          exitCode: 0,
          assistantText: "preamble junk that is not valid JSON",
          resultText: "",
          needsInput: false,
          sessionId: "mock",
          planText: VALID_PLAN,
        }) as AgentResult,
    };

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    const parsed = JSON.parse(written);
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0].name).toBe("Auth");
  });

  it("throws when agent produces invalid JSON", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent("I don't know how to make a plan from this.");

    await expect(generatePlan(inventoryPath, "", agent, outputDir)).rejects.toThrow("Invalid JSON");
  });

  it("throws when inventory file does not exist", async () => {
    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    await expect(
      generatePlan("/does/not/exist/inventory.md", "brief", agent, outputDir),
    ).rejects.toThrow();
  });

  it("throws descriptive error when agent returns empty response", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent("");

    await expect(generatePlan(inventoryPath, "", agent, outputDir)).rejects.toThrow("empty");
  });

  it("throws when agent returns non-JSON text", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent("Sure!\n# Just a single heading with no Group:");

    await expect(generatePlan(inventoryPath, "", agent, outputDir)).rejects.toThrow("Invalid JSON");
  });

  it("omits Codebase context section when briefContent is empty", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    let capturedPrompt = "";
    const agent: Pick<AgentHandle, 'send' | 'kill'> = {
      ...mockAgent(VALID_PLAN),
      send: async (prompt: string) => {
        capturedPrompt = prompt;
        return {
          exitCode: 0,
          assistantText: VALID_PLAN,
          resultText: "",
          needsInput: false,
          sessionId: "mock",
        };
      },
    };

    await generatePlan(inventoryPath, "", agent, outputDir);

    expect(capturedPrompt).not.toContain("## Codebase context");
    expect(capturedPrompt).toContain("## Feature inventory");
  });

  it("written file starts with valid JSON, not HTML comments", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    expect(written.startsWith("{")).toBe(true);
    const parsed = JSON.parse(written);
    expect(parsed.groups).toHaveLength(2);
  });

  it("writes pretty-printed JSON to disk", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN); // minified

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    // Must be multi-line (pretty-printed)
    expect(written).toContain("\n");
    // Must be valid JSON
    const parsed = JSON.parse(written);
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0].name).toBe("Auth");
    expect(parsed.groups[0].slices[0].title).toBe("User login");
  });

  it("written file is valid JSON that passes Zod validation", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    const parsed = PlanSchema.parse(JSON.parse(written));
    expect(parsed.groups[0].name).toBe("Auth");
    expect(parsed.groups[0].slices[0].number).toBe(1);
    expect(parsed.groups[0].slices[0].files[0].path).toBe("src/auth.ts");
  });

  it("written file round-trips through parsePlanJson matching result.groups", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const result = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(result.planPath, "utf-8");
    const reparsed = parsePlanJson(written, "round-trip");
    expect(reparsed).toHaveLength(result.groups.length);
    expect(reparsed[0].name).toBe(result.groups[0].name);
    expect(reparsed[0].slices).toHaveLength(result.groups[0].slices.length);
    expect(reparsed[0].slices[0].title).toBe(result.groups[0].slices[0].title);
    expect(reparsed[1].name).toBe(result.groups[1].name);
  });

  it("creates deeply nested output directories that do not exist", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, "nonexistent", "deep", ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    expect(written).toContain('"Auth"');
  });

  it("includes brief content in prompt sent to agent", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    let capturedPrompt = "";
    const agent: Pick<AgentHandle, 'send' | 'kill'> = {
      ...mockAgent(VALID_PLAN),
      send: async (prompt: string) => {
        capturedPrompt = prompt;
        return {
          exitCode: 0,
          assistantText: VALID_PLAN,
          resultText: "",
          needsInput: false,
          sessionId: "mock",
        };
      },
    };

    await generatePlan(inventoryPath, "TypeScript / NestJS stack", agent, outputDir);

    expect(capturedPrompt).toContain("TypeScript / NestJS stack");
    expect(capturedPrompt).toContain("# Features");
    expect(capturedPrompt).toContain("Transform this feature inventory");
  });

  it("prompt includes JSON schema shape and instructions", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    let capturedPrompt = "";
    const agent: Pick<AgentHandle, 'send' | 'kill'> = {
      ...mockAgent(VALID_PLAN),
      send: async (prompt: string) => {
        capturedPrompt = prompt;
        return {
          exitCode: 0,
          assistantText: VALID_PLAN,
          resultText: "",
          needsInput: false,
          sessionId: "mock",
        };
      },
    };

    await generatePlan(inventoryPath, "", agent, outputDir);

    // Must reference JSON schema fields
    for (const field of ["groups", "slices", "number", "title", "why", "files", "action", "details", "tests"]) {
      expect(capturedPrompt).toContain(`"${field}"`);
    }
    // Must instruct JSON output
    expect(capturedPrompt).toContain("valid JSON");
    // Must NOT contain old markdown format instructions
    expect(capturedPrompt).not.toContain("## Group:");
    expect(capturedPrompt).not.toContain("### Slice");
  });
});

// ─── planSummaryLines ──────────────────────────────────────────────────────

describe("planSummaryLines", () => {
  const groups = parsePlanJson(VALID_PLAN);

  it("returns a line with total group and slice counts", () => {
    const lines = planSummaryLines(groups);
    expect(lines[0]).toContain("2 groups");
    expect(lines[0]).toContain("3 slices");
  });

  it("uses singular 'slice' in per-group line for a group with exactly one slice", () => {
    const singleSliceGroups = parsePlanJson(JSON.stringify({
      groups: [{ name: "Solo", slices: [{ number: 1, title: "Only one", why: "Just one.", files: [{ path: "a.ts", action: "new" }], details: "d", tests: "t" }] }],
    }));
    const lines = planSummaryLines(singleSliceGroups);
    // Per-group line uses correct singular form
    const groupLine = lines.find((l) => l.includes("Solo"));
    expect(groupLine).toContain("1 slice");
    expect(groupLine).not.toContain("1 slices");
  });

  it("lists each group with name, slice count, and titles", () => {
    const lines = planSummaryLines(groups);
    const joined = lines.join("\n");
    expect(joined).toContain("Auth");
    expect(joined).toContain("2 slices");
    expect(joined).toContain("User login");
    expect(joined).toContain("Token refresh");
    expect(joined).toContain("Dashboard");
    expect(joined).toContain("1 slice");
    expect(joined).toContain("Widget rendering");
  });
});

// ─── doGeneratePlan ─────────────────────────────────────────────────────────

describe("doGeneratePlan", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dogen-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("calls generatePlan and returns the planPath", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");
    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);
    const log = () => {};

    const planPath = await doGeneratePlan(inventoryPath, "", outputDir, log, () => agent);

    expect(planPath).toMatch(/plan-[0-9a-f]{6}\.json$/);
    const written = readFileSync(planPath, "utf-8");
    expect(written).toContain('"Auth"');
  });

  it("logs group names and slice titles", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");
    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);
    const logged: string[] = [];
    const log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };

    await doGeneratePlan(inventoryPath, "", outputDir, log, () => agent);

    const all = logged.join("\n");
    expect(all).toContain("Auth");
    expect(all).toContain("Widget rendering");
    expect(all).toContain("3 slices");
  });

  it("summary slice count matches input", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");
    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);
    const logged: string[] = [];
    const log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };

    await doGeneratePlan(inventoryPath, "", outputDir, log, () => agent);

    const all = logged.join("\n");
    expect(all).toContain("2 groups");
    expect(all).toContain("3 slices");
  });

  it("kills the agent even if generatePlan throws", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");
    const outputDir = join(tmpDir, ".orch");
    const killed: boolean[] = [];
    const badAgent: Pick<AgentHandle, 'send' | 'kill'> = {
      ...mockAgent("not a plan"),
      kill: () => { killed.push(true); },
    };
    const log = () => {};

    await expect(doGeneratePlan(inventoryPath, "", outputDir, log, () => badAgent)).rejects.toThrow("Invalid JSON");
    expect(killed).toHaveLength(1);
  });
});
