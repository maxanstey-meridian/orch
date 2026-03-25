import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { generatePlan, isPlanFormat } from "./plan-generator.js";
import { parsePlanText } from "./plan-parser.js";
import type { AgentProcess, AgentResult } from "./agent.js";

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
  kill: () => {},
  get alive() { return true; },
  sessionId: "mock",
  style: { label: "TEST", color: "", badge: "" },
  get stderr() { return ""; },
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

  it("generates plan from inventory and writes to output dir", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nUsers can log in.\n\n## Dashboard\nWidgets.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const outPath = await generatePlan(inventoryPath, "Brief content here", agent, outputDir);

    expect(outPath).toBe(join(outputDir, "generated-plan.md"));
    const written = readFileSync(outPath, "utf-8");
    expect(written).toContain("## Group: Auth");
    expect(written).toContain("### Slice 1: User login");
  });

  it("strips preamble from agent response", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Login\nLogin feature.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(PLAN_WITH_PREAMBLE);

    const outPath = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(outPath, "utf-8");
    expect(written.startsWith("## Group:")).toBe(true);
    expect(written).not.toContain("Here's the plan");
  });

  it("generated plan parses successfully via parsePlanText", async () => {
    const inventoryPath = join(tmpDir, "inventory.md");
    writeFileSync(inventoryPath, "# Features\n\n## Auth\nLogin.");

    const outputDir = join(tmpDir, ".orch");
    const agent = mockAgent(VALID_PLAN);

    const outPath = await generatePlan(inventoryPath, "", agent, outputDir);

    const written = readFileSync(outPath, "utf-8");
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
