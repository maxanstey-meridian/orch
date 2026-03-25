import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { parsePlanText } from "./plan-parser.js";
import type { AgentProcess } from "./agent.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const GENERATED_PLAN_FILE = "generated-plan.md";

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

export const generatePlan = async (
  inventoryPath: string,
  briefContent: string,
  agent: AgentProcess,
  outputDir: string,
): Promise<string> => {
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

  // Write to disk
  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, GENERATED_PLAN_FILE);
  writeFileSync(outPath, planText);

  return outPath;
};
