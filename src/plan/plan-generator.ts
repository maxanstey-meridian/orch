import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { PlanSchema, parsePlanJson } from "./plan-schema.js";
import type { Group } from "./plan-parser.js";
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

Output valid JSON matching this schema:

\`\`\`json
{
  "groups": [
    {
      "name": "<group name>",
      "description": "<optional group description>",
      "slices": [
        {
          "number": 1,
          "title": "<slice title>",
          "why": "<one sentence explaining why this slice is needed>",
          "files": [
            { "path": "src/foo.ts", "action": "new" },
            { "path": "src/bar.ts", "action": "edit" }
          ],
          "details": "<concrete implementation details — what to build, how it connects>",
          "tests": "<what to test, which file>"
        }
      ]
    }
  ]
}
\`\`\`

## Field reference

- \`"action"\` must be one of: \`"new"\`, \`"edit"\`, \`"delete"\`.
- \`"number"\` is a positive integer — globally unique across the entire plan.
- \`"files"\` must have at least one entry per slice.
- All string fields (\`"name"\`, \`"title"\`, \`"why"\`, \`"details"\`, \`"tests"\`) must be non-empty.

## Rules

- **Slice numbers must be GLOBALLY unique and sequential across the entire plan.** Group 1 has Slices 1-3, Group 2 has Slices 4-6, etc. Do NOT restart numbering per group. The orchestrator tracks progress by slice number — duplicate numbers cause slices to be skipped.
- Target 2-3 slices per group, max 4. Respect dependency ordering.
- Output ONLY the JSON object — no preamble, no commentary, no wrapping text.`;

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

/** Extract the outermost JSON object from agent text that may include preamble/postamble. */
export const extractJson = (text: string): string => {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) return text.slice(jsonStart, jsonEnd + 1);
  return text;
};

// ─── Summary ────────────────────────────────────────────────────────────────

export const formatPlanSummary = (groups: readonly Group[]): string[] => {
  const totalSlices = groups.reduce((sum, g) => sum + g.slices.length, 0);
  const lines: string[] = [`${a.bold}Plan: ${groups.length} groups, ${totalSlices} slices${a.reset}`];
  for (const g of groups) {
    const n = g.slices.length;
    const titles = g.slices.map((s) => `#${s.number} ${s.title}`).join(", ");
    lines.push(`  ${a.cyan}${g.name}${a.reset} (${n} slice${n === 1 ? "" : "s"}) — ${titles}`);
  }
  return lines;
};

// ─── Plan generation ────────────────────────────────────────────────────────

export type GeneratePlanResult = { planPath: string; planId: string };

export const generatePlan = async (
  inventoryPath: string,
  briefContent: string,
  agent: AgentProcess,
  outputDir: string,
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
  const planText = extractJson(best).trim();

  if (!planText) {
    throw new Error(
      `Plan agent returned empty output.\nassistantText length: ${raw.length}\nplanText length: ${planFromExit.length}\nFirst 500 chars of assistantText:\n${raw.slice(0, 500)}`,
    );
  }

  // Parse and validate via Zod
  let parsed: unknown;
  try {
    parsed = JSON.parse(planText);
  } catch (e) {
    throw new Error(`Invalid JSON in generated plan — ${(e as Error).message}`);
  }
  const validation = PlanSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues.map((i: { path: (string | number)[]; message: string }) =>
      `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid plan (generated plan):\n${issues}`);
  }

  const formatted = JSON.stringify(validation.data, null, 2);
  const planId = generatePlanId();

  // Write to disk
  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, planFileName(planId));
  writeFileSync(outPath, formatted);

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
    );
    log(`${a.green}Plan written to ${planPath}${a.reset}`);
    const json = readFileSync(planPath, "utf-8");
    const groups = parsePlanJson(json, planPath);
    for (const line of formatPlanSummary(groups)) {
      log(line);
    }
    return planPath;
  } finally {
    planAgent.kill();
  }
};
