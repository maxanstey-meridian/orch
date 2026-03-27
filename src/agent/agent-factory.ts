import { readFileSync } from "fs";
import { resolve } from "path";
import { createAgent, type AgentProcess, type AgentStyle } from "./agent.js";
import { BOT_PLAN } from "../ui/display.js";

// ─── Agent helpers ───────────────────────────────────────────────────────────

const BASE_FLAGS = ["--dangerously-skip-permissions"] as const;
const PLAN_FLAGS = ["--permission-mode", "plan"] as const;

export const spawnAgent = (
  style: AgentStyle,
  systemPrompt?: string,
  resumeSessionId?: string,
  cwd?: string,
): AgentProcess =>
  createAgent({
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

export const spawnPlanAgent = (style: AgentStyle, systemPrompt?: string, cwd?: string): AgentProcess =>
  createAgent({
    command: "claude",
    args: [
      ...PLAN_FLAGS,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ],
    style,
    cwd,
  });

const planSkillContent = readFileSync(
  resolve(import.meta.dirname, "..", "..", "skills", "plan.md"),
  "utf-8",
);

const generatePlanSkillContent = readFileSync(
  resolve(import.meta.dirname, "..", "..", "skills", "generate-plan.md"),
  "utf-8",
);

export const spawnPlanAgentWithSkill = (cwd?: string): AgentProcess =>
  spawnPlanAgent(BOT_PLAN, planSkillContent, cwd);

export const spawnGeneratePlanAgent = (cwd?: string): AgentProcess =>
  spawnPlanAgent(BOT_PLAN, generatePlanSkillContent, cwd);

export const TDD_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. RUN TESTS WITH BASH. Use your Bash tool to execute tests. Read the actual output. Do not narrate "RED confirmed" or "GREEN" without executing. No exceptions.
2. COMMIT WHEN DONE. After all behaviours are GREEN, run the full test suite, then git add + git commit. Uncommitted work is invisible to the review agent.
3. STAY IN SCOPE. Only modify files relevant to your current task. Do not touch, revert, or "clean up" unrelated files. Use git add with specific filenames, never git add . or git add -A.
4. USE CLASSES FOR STATEFUL SERVICES. Do not create standalone functions with deps bags or parameter objects. If something holds state or coordinates multiple operations, make it a class with constructor injection. Methods access dependencies via \`this\`, not via passed-in params objects.`;

export const REVIEW_RULES_REMINDER = `[ORCHESTRATOR] Non-negotiable rules for your operation. Acknowledge silently — do not respond to this message.

1. ONLY REVIEW THE DIFF. Review files changed in the diff. Ignore unrelated uncommitted changes in the working tree — they belong to the operator.
2. DO NOT SUGGEST REVERTING unrelated files (skill files, config, HUD changes) that weren't part of the slice.
3. If the diff is empty and HEAD hasn't moved, respond with REVIEW_CLEAN. Do not claim work is missing if it was committed in prior commits.`;
