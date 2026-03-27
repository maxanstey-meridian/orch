import { BOT_PLAN, BOT_TDD } from "./display.js";
import { withBrief } from "./prompts.js";
import type { PlanThenExecuteDeps, PlanThenExecuteResult } from "./orchestrator.js";

// ─── Plan-then-execute ──────────────────────────────────────────────────────

const buildPlanPrompt = (sliceContent: string): string =>
  `You are a planning agent. Explore the codebase and produce a step-by-step TDD execution plan for the following slice.

## Plan Slice
${sliceContent}

## Instructions
1. Read the relevant files to understand current state.
2. Output numbered RED→GREEN cycles. Each cycle: one failing test, then minimal code to pass.
3. Do NOT write any code — plan only.`;

export const planThenExecute = async (
  deps: PlanThenExecuteDeps,
): Promise<PlanThenExecuteResult> => {
  // ── Plan phase ──
  const planPrompt = withBrief(buildPlanPrompt(deps.sliceContent), deps.brief);
  const ps = deps.makePlanStreamer();
  const planResult = await deps.withInterrupt(deps.planAgent, () =>
    deps.planAgent.send(planPrompt, ps, deps.onToolUse),
  );
  ps.flush();

  if (deps.isSkipped()) {
    deps.planAgent.kill();
    return { tddResult: planResult, skipped: true };
  }

  const hardInterruptGuidance = deps.isHardInterrupted();
  if (hardInterruptGuidance) {
    deps.planAgent.kill();
    return { tddResult: planResult, skipped: false, hardInterrupt: hardInterruptGuidance };
  }

  deps.planAgent.kill();

  // Extract plan text — prefer structured planText, fall back to assistantText
  const plan = planResult.planText ?? planResult.assistantText ?? "";

  // ── Confirmation gate ──
  let operatorGuidance = "";
  if (!deps.noInteraction && deps.askUser) {
    const planLines = plan.split("\n");
    const MAX_PREVIEW = 30;
    const preview = planLines.slice(0, MAX_PREVIEW).join("\n");
    deps.log(`${BOT_PLAN.badge} plan ready`);
    deps.onPlanReady?.();
    deps.log(preview);
    if (planLines.length > MAX_PREVIEW) {
      deps.log(`... (truncated, ${planLines.length} lines)`);
    }
    const answer = await deps.askUser("Accept plan? (y)es / (e)dit / (r)eplan: ");
    if (answer.startsWith("r")) {
      return { tddResult: planResult, skipped: false, replan: true };
    }
    if (answer.startsWith("e")) {
      operatorGuidance = await deps.askUser("Guidance for execution: ");
    }
    // "y", empty, or after guidance — fall through to execute
  }

  // ── Execute phase ──
  deps.log(`${BOT_TDD.badge} executing plan...`);
  const rawExecutePrompt = operatorGuidance
    ? `Operator guidance: ${operatorGuidance}\n\nExecute this plan:\n\n${plan}`
    : `Execute this plan:\n\n${plan}`;
  const executePrompt = withBrief(rawExecutePrompt, deps.brief);
  const es = deps.makeExecuteStreamer();
  const tddResult = await deps.withInterrupt(deps.tddAgent, () =>
    deps.tddAgent.send(executePrompt, es, deps.onToolUse),
  );
  es.flush();

  if (deps.isSkipped()) {
    return { tddResult, skipped: true };
  }

  const execInterrupt = deps.isHardInterrupted();
  if (execInterrupt) {
    return { tddResult, skipped: false, hardInterrupt: execInterrupt };
  }

  return { tddResult, skipped: false };
};
