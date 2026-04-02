import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { PromptAgent } from "#application/ports/agent-spawner.port.js";
import type { ExecutionMode } from "#domain/config.js";
import { a, type LogFn } from "#ui/display.js";
import type { Group } from "./plan-parser.js";
import { PlanSchema, parsePlanJson } from "./plan-schema.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const generatePlanId = (): string => randomBytes(3).toString("hex");

export const planFileName = (id: string): string => `plan-${id}.json`;

const PLAN_ID_RE = /plan-([0-9a-f]{6})\.json$/;

export const planIdFromPath = (planPath: string): string => {
  const match = PLAN_ID_RE.exec(planPath);
  if (!match) {
    throw new Error(`Cannot extract plan ID from path: ${planPath}`);
  }
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
  "context": {
    "architecture": "<optional architecture summary>",
    "keyFiles": {
      "src/foo.ts": "<why this file matters>"
    },
    "concepts": {
      "someConcept": "<important product/runtime concept>"
    },
    "conventions": {
      "testingBias": "<important implementation or testing convention>"
    }
  },
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
- Top-level \`"context"\` is optional, but include it when you can infer useful repo-wide guidance that will reduce re-exploration for implementing agents.
- Within \`"context"\`, \`"architecture"\` is an optional string and \`"keyFiles"\`, \`"concepts"\`, and \`"conventions"\` are optional string-to-string maps.

## Rules

- **Slice numbers must be GLOBALLY unique and sequential across the entire plan.** Group 1 has Slices 1-3, Group 2 has Slices 4-6, etc. Do NOT restart numbering per group. The orchestrator tracks progress by slice number — duplicate numbers cause slices to be skipped.
- Target 2-3 slices per group, max 4. Respect dependency ordering.
- Use top-level \`"context"\` for stable repo knowledge only: architecture boundaries, authoritative files, product/runtime concepts, and conventions that apply across multiple slices. Do not duplicate slice-specific details there.
- Output ONLY the raw JSON object. No markdown code fences, no \`\`\`json blocks, no preamble, no commentary, no explanation before or after. The very first character of your response must be \`{\` and the very last must be \`}\`.`;

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
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    return text;
  }
  // Try the full span first, then shrink from the end to find valid JSON
  for (let end = jsonEnd; end > jsonStart; end = text.lastIndexOf("}", end - 1)) {
    const candidate = text.slice(jsonStart, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // keep shrinking
    }
  }
  return text.slice(jsonStart, jsonEnd + 1);
};

// ─── Summary ────────────────────────────────────────────────────────────────

export const planSummaryLines = (groups: readonly Group[]): string[] => {
  const totalSlices = groups.reduce((sum, g) => sum + g.slices.length, 0);
  const lines: string[] = [
    `${a.bold}Plan: ${groups.length} groups, ${totalSlices} slices${a.reset}`,
  ];
  for (const g of groups) {
    const n = g.slices.length;
    const titles = g.slices.map((s) => `#${s.number} ${s.title}`).join(", ");
    lines.push(`  ${a.cyan}${g.name}${a.reset} (${n} slice${n === 1 ? "" : "s"}) — ${titles}`);
  }
  return lines;
};

// ─── Plan generation ────────────────────────────────────────────────────────

export type GeneratePlanResult = { planPath: string; planId: string; groups: readonly Group[] };

export const generatePlan = async (
  inventoryPath: string,
  briefContent: string,
  agent: PromptAgent,
  outputDir: string,
  targetExecutionMode: Exclude<ExecutionMode, "direct"> = "sliced",
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

  // Parse, validate via Zod, and map to Group[]
  let planDocument: ReturnType<typeof PlanSchema.parse>;
  let groups: readonly Group[];
  try {
    let rawPlan: Record<string, unknown>;
    try {
      rawPlan = JSON.parse(planText) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid JSON in plan: generated plan — ${(error as Error).message}`);
    }
    planDocument = PlanSchema.parse({
      ...rawPlan,
      executionMode: targetExecutionMode,
    });
    groups = parsePlanJson(JSON.stringify(planDocument), "generated plan");
  } catch (e) {
    console.error("--- RAW AGENT OUTPUT ---");
    console.error(best);
    console.error("--- EXTRACTED JSON ---");
    console.error(planText);
    console.error("------------------------");
    throw e;
  }

  // Pretty-print the validated JSON for disk
  const formatted = JSON.stringify(planDocument, null, 2);
  const planId = generatePlanId();

  // Write to disk
  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, planFileName(planId));
  writeFileSync(outPath, formatted);

  return { planPath: outPath, planId, groups };
};

export const doGeneratePlan = async (
  inventoryPath: string,
  briefContent: string,
  outputDir: string,
  log: LogFn,
  spawnPlanAgent: () => PromptAgent,
  targetExecutionMode: Exclude<ExecutionMode, "direct"> = "sliced",
): Promise<string> => {
  log(`${a.bold}Generating plan from inventory...${a.reset}`);
  const planAgent = spawnPlanAgent();
  try {
    const { planPath, groups } = await generatePlan(
      inventoryPath,
      briefContent,
      planAgent,
      outputDir,
      targetExecutionMode,
    );
    log(`${a.green}Plan written to ${planPath}${a.reset}`);
    for (const line of planSummaryLines(groups)) {
      log(line);
    }
    return planPath;
  } finally {
    planAgent.kill();
  }
};
