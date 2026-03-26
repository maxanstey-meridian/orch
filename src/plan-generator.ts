import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { parsePlanText } from "./plan-parser.js";
import type { AgentProcess } from "./agent.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const generatePlanId = (): string => randomBytes(3).toString("hex");

export const planFileName = (id: string): string => `plan-${id}.md`;

const PLAN_ID_RE = /plan-([0-9a-f]{6})\.md$/;

export const planIdFromPath = (planPath: string): string => {
  const match = PLAN_ID_RE.exec(planPath);
  if (!match) throw new Error(`Cannot extract plan ID from path: ${planPath}`);
  return match[1];
};

const PLAN_INSTRUCTIONS = `Transform this feature inventory into a group-and-slice plan.

Use \`## Group: <name>\` headings and \`### Slice <N>: <title>\` headings.
Number slices sequentially from 1. Each slice needs: **Why**, **Files**,
concrete implementation details, and **Tests**.
Target 2-3 slices per group, max 4. Respect dependency ordering.

Output ONLY the plan markdown — no preamble, no commentary.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

const GROUP_RE = /^## Group:/m;

/** True if content already has group headings (is a plan, not an inventory). */
export const isPlanFormat = (content: string): boolean => GROUP_RE.test(content);

/**
 * Strip conversational preamble before the first markdown heading.
 * Does NOT strip postamble — plan bodies contain prose paragraphs
 * that would be false-positives. Validation catches bad output.
 */
const stripPreamble = (text: string): string => {
  if (text.startsWith("#")) return text;
  const idx = text.indexOf("\n#");
  if (idx === -1) return text;
  return text.slice(idx + 1);
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

  const planText = stripPreamble(result.assistantText).trim();

  // Validate — parsePlanText throws if no groups found
  parsePlanText(planText, "generated plan");

  // Build output with optional source comment
  const prefix = sourcePath ? `<!-- Generated from: ${sourcePath} -->\n` : "";
  const planId = generatePlanId();

  // Write to disk
  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, planFileName(planId));
  writeFileSync(outPath, prefix + planText);

  return { planPath: outPath, planId };
};
