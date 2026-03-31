import { readFileSync } from "fs";
import { resolve } from "path";
import type { AgentStyle } from "#domain/agent-types.js";
import { BOT_PLAN, BOT_GAP } from "#ui/display.js";
import { createClaudeAgent, type ClaudeAgentProcess } from "./claude-agent-process.js";

// ─── Agent helpers ───────────────────────────────────────────────────────────

const BASE_FLAGS = ["--dangerously-skip-permissions"] as const;
const PLAN_FLAGS = ["--permission-mode", "plan"] as const;

export const spawnClaudeAgent = (
  style: AgentStyle,
  systemPrompt?: string,
  resumeSessionId?: string,
  cwd?: string,
): ClaudeAgentProcess =>
  createClaudeAgent({
    command: "claude",
    args: [
      ...BASE_FLAGS,
      ...(resumeSessionId ? ["--resume", resumeSessionId] : ["-p"]),
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ],
    style,
    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
    cwd,
  });

export const spawnClaudePlanAgent = (
  style: AgentStyle,
  systemPrompt?: string,
  cwd?: string,
  model?: string,
): ClaudeAgentProcess =>
  createClaudeAgent({
    command: "claude",
    args: [
      ...PLAN_FLAGS,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(model ? ["--model", model] : []),
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ],
    style,
    cwd,
  });

const planSkillContent = readFileSync(
  resolve(import.meta.dirname, "..", "..", "..", "skills", "plan.md"),
  "utf-8",
);

const generatePlanSkillContent = readFileSync(
  resolve(import.meta.dirname, "..", "..", "..", "skills", "generate-plan.md"),
  "utf-8",
);

const gapSkillContent = readFileSync(
  resolve(import.meta.dirname, "..", "..", "..", "skills", "gap.md"),
  "utf-8",
);

export const spawnClaudeGapAgent = (cwd?: string): ClaudeAgentProcess =>
  spawnClaudeAgent(BOT_GAP, gapSkillContent, undefined, cwd);

export const spawnClaudePlanAgentWithSkill = (cwd?: string): ClaudeAgentProcess =>
  spawnClaudePlanAgent(BOT_PLAN, planSkillContent, cwd);

export const spawnClaudeGeneratePlanAgent = (cwd?: string): ClaudeAgentProcess =>
  spawnClaudeAgent(BOT_PLAN, generatePlanSkillContent, undefined, cwd);

export const buildRulesReminder = (baseRules: string, extraRules?: string): string =>
  !extraRules
    ? baseRules
    : `${baseRules}\n\n[PROJECT] Additional rules from .orchrc.json:\n${extraRules}`;

export const TDD_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. RUN TESTS WITH BASH. Use your Bash tool to execute tests. Read the actual output. Do not narrate "RED confirmed" or "GREEN" without executing. No exceptions.
2. COMMIT WHEN DONE. After all behaviours are GREEN, run the full test suite, then git add + git commit. Uncommitted work is invisible to the review agent.
3. STAY IN SCOPE. Only modify files relevant to your current task. Do not touch, revert, or "clean up" unrelated files. Use git add with specific filenames, never git add . or git add -A.
4. USE CLASSES FOR STATEFUL SERVICES. Do not create standalone functions with deps bags or parameter objects. If something holds state or coordinates multiple operations, make it a class with constructor injection. Methods access dependencies via \`this\`, not via passed-in params objects.
5. WRITE DEFENSIVE TESTS. For every feature, verify: if someone deleted the key line that makes it work, would a test fail? If not, add one. Test observable state changes directly — not mock call arguments. A test that passes whether the feature works or not is worse than no test.`;

export const REVIEW_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. ONLY REVIEW THE DIFF. Review files changed in the diff. Ignore unrelated uncommitted changes in the working tree — they belong to the operator.
2. DO NOT SUGGEST REVERTING unrelated files (skill files, config, HUD changes) that weren't part of the slice.
3. If the diff is empty and HEAD hasn't moved, respond with REVIEW_CLEAN. Do not claim work is missing if it was committed in prior commits.`;
