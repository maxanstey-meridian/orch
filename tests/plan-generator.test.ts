import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { generatePlan, isPlanFormat, planFileName, planIdFromPath, generatePlanId } from "../src/plan-generator.js";
import { parsePlanText } from "../src/plan-parser.js";
import type { AgentProcess, AgentResult } from "../src/agent.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_PLAN = `## Group: Auth

### Slice 1: User login

**Why:** Users need to log in.

**Files:** src/auth.ts

**Tests:** Login works.

### Slice 2: Token refresh

**Why:** Tokens expire.

**Files:** src/auth.ts

**Tests:** Refresh works.

## Group: Dashboard

### Slice 3: Widget rendering

**Why:** Users need widgets.

**Files:** src/dashboard.ts

**Tests:** Widgets render.`;

const PLAN_WITH_PREAMBLE = `Here's the plan I generated:

${VALID_PLAN}

Let me know if you'd like changes.`;

const mockAgent = (responseText: string): AgentProcess => ({
  send: async (_prompt: string) =>
    ({
      exitCode: 0,
      assistantText: responseText,
      resultText: "",
      needsInput: false,
      sessionId: "mock",
    }) as AgentResult,
  sendQuiet: async (_prompt: string) => responseText,
  inject: () => {},
  kill: () => {},
  get alive() { return true; },
  sessionId: "mock",
  style: { label: "TEST", color: "", badge: "" },
  get stderr() { return ""; },
});

// ─── planFileName ───────────────────────────────────────────────────────────

describe("planFileName", () => {
  it("returns plan-<id>.md for a given hex id", () => {
    expect(planFileName("a1b2c3")).toBe("plan-a1b2c3.md");
  });
});

// ─── planIdFromPath ─────────────────────────────────────────────────────────

describe("planIdFromPath", () => {
  it("extracts the 6-char hex id from a valid plan path", () => {
    expect(planIdFromPath("/foo/.orch/plan-a1b2c3.md")).toBe("a1b2c3");
  });

  it("throws when filename does not match plan-<hex>.md pattern", () => {
    expect(() => planIdFromPath("/foo/random.md")).toThrow("Cannot extract plan ID");
  });

  it("throws for uppercase hex in filename", () => {
    expect(() => planIdFromPath("/foo/.orch/plan-A1B2C3.md")).toThrow("Cannot extract plan ID");
  });

  it("throws for too-short hex (5 chars)", () => {
    expect(() => planIdFromPath("/foo/.orch/plan-a1b2c.md")).toThrow("Cannot extract plan ID");
  });

  it("throws for too-long hex (7 chars)", () => {
    expect(() => planIdFromPath("/foo/.orch/plan-a1b2c3d.md")).toThrow("Cannot extract plan ID");
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

// ─── isPlanFormat ───────────────────────────────────────────────────────────

describe("isPlanFormat", () => {
  it("returns true for content with ## Group: headings", () => {
    expect(isPlanFormat(VALID_PLAN)).toBe(true);
  });

  it("returns false for inventory content without group headings", () => {
    const inventory = `# Feature Inventory\n\n## Login\nUsers can log in.\n\n## Dashboard\nUsers see widgets.`;
    expect(isPlanFormat(inventory)).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(isPlanFormat("")).toBe(false);
  });

  it("returns true when ## Group: appears inside a code fence (known limitation)", () => {
    const fenced = "```\n## Group: fake\n```";
    // Documents current behavior: regex doesn't distinguish code fences
    expect(isPlanFormat(fenced)).toBe(true);
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

  it("writes plan to plan-<id>.md and returns planPath and planId", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nUsers can log in.\n\n## Dashboard\nWidgets.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const result = await generatePlan(inventoryPath, "Brief content here", agent, outputDir);

    expect(result.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(result.planPath).toBe(join(outputDir, `plan-${result.planId}.md`));
    const written = readFileSync(result.planPath, "utf-8");
    expect(written).toContain("## Group: Auth");
    expect(written).toContain("### Slice 1: User login");
  });

  it("strips preamble from agent response", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nLogin feature.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(PLAN_WITH_PREAMBLE);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    expect(written).toContain("## Group:");
    expect(written).not.toContain("Here's the plan");
  });

  it("generated plan parses successfully via parsePlanText", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    const groups = parsePlanText(written);
    expect(groups.length).toBe(2);
    expect(groups[0].name).toBe("Auth");
    expect(groups[0].slices).toHaveLength(2);
    expect(groups[1].name).toBe("Dashboard");
    expect(groups[1].slices).toHaveLength(1);
  });

  it("throws when agent produces no valid groups", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent("I don't know how to make a plan from this.");

    await expect(generatePlan(inventoryPath, "", agent, outputDir)).rejects.toThrow("No groups found");
  });

  it("throws when inventory file does not exist", async () => {
    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    await expect(
      generatePlan("/does/not/exist/inventory.md", "brief", agent, outputDir),
    ).rejects.toThrow();
  });

  it("throws 'No groups found' when agent returns preamble with heading but no Group:", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent("Sure!\n# Just a single heading with no Group:");

    await expect(generatePlan(inventoryPath, "", agent, outputDir)).rejects.toThrow("No groups found");
  });

  it("omits Codebase context section when briefContent is empty", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    let capturedPrompt = "";
    const agent: AgentProcess = {
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

  it("omits source comment when sourcePath is not provided", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(planPath, "utf-8");
    expect(written.startsWith("<!--")).toBe(false);
  });

  it("prepends source comment when sourcePath is provided", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir, "features/inventory.md");

    const written = readFileSync(planPath, "utf-8");
    expect(written.startsWith("<!-- Generated from: features/inventory.md -->")).toBe(true);
  });

  it("plan with source comment prefix still parses via parsePlanText", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const { planPath } = await generatePlan(inventoryPath, "", agent, outputDir, "inv.md");

    const written = readFileSync(planPath, "utf-8");
    expect(written.startsWith("<!--")).toBe(true);
    const groups = parsePlanText(written);
    expect(groups.length).toBe(2);
    expect(groups[0].name).toBe("Auth");
  });

  it("includes brief content in prompt sent to agent", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    let capturedPrompt = "";
    const agent: AgentProcess = {
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
});
