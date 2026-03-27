import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { parsePlanJson } from "./plan-schema.js";
import type { AgentProcess } from "../agent/agent.js";
import { a, type LogFn } from "../ui/display.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const generatePlanId = (): string => randomBytes(3).toString("hex");

export const planFileName = (id: string): string => `plan-${id}.json`;

const PLAN_ID_RE = /plan-([0-9a-f]{6})\.json$/;

export const planIdFromPath = (planPath: string): string => {
  const match = PLAN_ID_RE.exec(planPath);
  if (!match) throw new Error(`Cannot extract plan ID from path: ${planPath}`);
  return match[1];
};

export const resolvePlanId = (planPath: string): string => {
  try {
    return planIdFromPath(planPath);
  } catch {
    return createHash("sha256").update(planPath).digest("hex").slice(0, 6);
  }
};

export const ensureCanonicalPlan = (planPath: string, orchDir: string): string => {
  const id = resolvePlanId(planPath);
  // Only copy if the path doesn't already match plan-<id>.json
  try {
    planIdFromPath(planPath);
    return id;
  } catch {
    // External plan — copy to canonical location if not already present
    mkdirSync(orchDir, { recursive: true });
    const canonicalPath = resolve(orchDir, planFileName(id));
    if (!existsSync(canonicalPath)) {
      writeFileSync(canonicalPath, readFileSync(planPath, "utf-8"));
    }
    return id;
  }
};

const PLAN_INSTRUCTIONS = `Transform this feature inventory into a group-and-slice plan.

**You are generating the HIGH-LEVEL plan structure, NOT per-cycle TDD plans.** Ignore the Cycle N format from your system prompt — that is for a different task.

## Required format

Use exactly this heading structure:

\`\`\`
## Group: <group name>

<optional group description>

### Slice 1: <slice title>

**Why:** <one sentence>

**Files:** \`src/foo.ts\` (new), \`src/bar.ts\` (edit)

<concrete implementation details — what to build, how it connects>

**Tests:** <what to test, which file>

### Slice 2: <slice title>

...
\`\`\`

## Rules

- Heading levels matter: \`##\` for groups, \`###\` for slices. Do not deviate.
- **Slice numbers must be GLOBALLY unique and sequential across the entire plan.** Group 1 has Slices 1-3, Group 2 has Slices 4-6, etc. Do NOT restart numbering per group. The orchestrator tracks progress by slice number — duplicate numbers cause slices to be skipped.
- Target 2-3 slices per group, max 4. Respect dependency ordering.
- Each slice needs: **Why**, **Files**, concrete details, and **Tests**.
- Output ONLY the plan markdown — no preamble, no commentary, no wrapping text.
- Start your output with \`## Group:\` — the very first line must be a group heading.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** True if content is a JSON plan with a groups array. */
export const isPlanFormat = (content: string): boolean => {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.groups);
  } catch {
    return false;
  }
};

/**
 * Strip conversational preamble before the first markdown heading.
 * Does NOT strip postamble — plan bodies contain prose paragraphs
 * that would be false-positives. Validation catches bad output.
 */
const stripPreamble = (text: string): string => {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) return text.slice(jsonStart, jsonEnd + 1);
  return text;
};

// ─── Plan generation ────────────────────────────────────────────────────────

export type GeneratePlanResult = { planPath: string; planId: string };

export const generatePlan = async (
  inventoryPath: string,
  briefContent: string,
  agent: AgentProcess,
  outputDir: string,
  sourcePath?: string,
): Promise<GeneratePlanResult> => {
  const inventory = readFileSync(inventoryPath, "utf-8");

  const parts: string[] = [];
  if (briefContent) {
    parts.push("## Codebase context\n\n" + briefContent);
  }
  parts.push("## Feature inventory\n\n" + inventory);
  parts.push(PLAN_INSTRUCTIONS);

  const prompt = parts.join("\n\n---\n\n");
  const result = await agent.send(prompt);

  const raw = result.assistantText ?? "";
  const planFromExit = result.planText ?? "";
  const best = planFromExit || raw;
  const planText = stripPreamble(best).trim();

  if (!planText) {
    throw new Error(
      `Plan agent returned empty output.\nassistantText length: ${raw.length}\nplanText length: ${planFromExit.length}\nFirst 500 chars of assistantText:\n${raw.slice(0, 500)}`,
    );
  }

  // Validate — parsePlanText throws if no groups found
  parsePlanJson(planText, "generated plan");

  // Build output with optional source comment
  const prefix = sourcePath ? `<!-- Generated from: ${sourcePath} -->\n` : "";
  const planId = generatePlanId();

  // Write to disk
  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, planFileName(planId));
  writeFileSync(outPath, prefix + planText);

  return { planPath: outPath, planId };
};

export const doGeneratePlan = async (
  inventoryPath: string,
  briefContent: string,
  outputDir: string,
  log: LogFn,
  spawnPlanAgent: () => AgentProcess,
): Promise<string> => {
  log(`${a.bold}Generating plan from inventory...${a.reset}`);
  const planAgent = spawnPlanAgent();
  try {
    const { planPath } = await generatePlan(
      inventoryPath,
      briefContent,
      planAgent,
      outputDir,
      inventoryPath,
    );
    log(`${a.green}Plan written to ${planPath}${a.reset}`);
    return planPath;
  } finally {
    planAgent.kill();
  }
};
