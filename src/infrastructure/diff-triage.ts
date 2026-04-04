import { z } from "zod";
import type { ExecutionUnitTriageInput } from "#application/ports/execution-unit-triager.port.js";
import {
  fullTriageForTier,
  type ComplexityTier,
  type PassDecision,
  type TriageResult,
} from "#domain/triage.js";

const passDecisionSchema = z.enum(["run_now", "defer", "skip"]);

const triageSchema = z
  .object({
    nextTier: z.enum(["trivial", "small", "medium", "large"]),
    completeness: passDecisionSchema,
    verify: passDecisionSchema,
    review: passDecisionSchema,
    gap: passDecisionSchema,
    reason: z.string().trim().min(1),
  })
  .strict();

const legacySchema = z
  .object({
    completeness: z.boolean(),
    verify: z.boolean(),
    review: z.boolean(),
    gap: z.boolean(),
    reason: z.string().trim().min(1),
  })
  .strict();

const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return text.slice(start, end + 1);
};

const describePendingPasses = (input: ExecutionUnitTriageInput): string => {
  const pending = Object.entries(input.pending)
    .filter(([, active]) => active)
    .map(([name]) => name);
  return pending.length === 0 ? "none" : pending.join(", ");
};

export const buildTriagePrompt = (
  input: ExecutionUnitTriageInput,
): string => `You are the runtime policy classifier for a TDD orchestration pipeline.

The orchestrator has just finished one execution boundary and needs you to decide:
- which expensive passes should run now
- which should be deferred to a later boundary
- which should be skipped for the changes accumulated so far
- what complexity tier the NEXT execution unit should use

Classify the completed unit using:
- file count
- scope of the change
- nature of the change
- cascade risk across adjacent code paths
- whether another unit still exists in the current group
- whether this is the final boundary before group/run finalisation
- the current accumulated pending pass windows

Current context:
- mode: ${input.mode}
- unit kind: ${input.unitKind}
- current tier: ${input.currentTier}
- unit diff stats: +${input.diffStats.added} / -${input.diffStats.removed} / total ${input.diffStats.total}
- review threshold hint: ${input.reviewThreshold}
- final boundary: ${input.finalBoundary ? "yes" : "no"}
- more units remain in current group: ${input.moreUnitsInGroup ? "yes" : "no"}
- pending pass windows: ${describePendingPasses(input)}

Return a JSON object with exactly these keys:
- nextTier
- completeness
- verify
- review
- gap
- reason

Use:
- one of "trivial" | "small" | "medium" | "large" for nextTier
- one of "run_now" | "defer" | "skip" for completeness / verify / review / gap
- a short concrete string for reason

Guidance:
- Use "defer" when the pass should be batched with a later unit or group boundary.
- Use "skip" when the pass should NOT run for the changes accumulated so far and the pending window should advance.
- Use "run_now" when the pass should run at this boundary.
- If this is a final boundary with no useful later batching point, strongly prefer "run_now" or "skip" over "defer".
Output ONLY the raw JSON object. No markdown code fences, no commentary, no explanation before or after.

## Diff
${input.diff}`;

const mapLegacyDecision = (value: boolean): PassDecision => (value ? "run_now" : "skip");

export const parseTriageResult = (text: string, currentTier: ComplexityTier): TriageResult => {
  try {
    const json = extractJsonObject(text);
    if (json === null) {
      return fullTriageForTier(currentTier);
    }

    const parsed = JSON.parse(json) as unknown;
    const next = triageSchema.safeParse(parsed);
    if (next.success) {
      return next.data;
    }

    const legacy = legacySchema.safeParse(parsed);
    if (!legacy.success) {
      return fullTriageForTier(currentTier);
    }

    return {
      nextTier: currentTier,
      completeness: mapLegacyDecision(legacy.data.completeness),
      verify: mapLegacyDecision(legacy.data.verify),
      review: mapLegacyDecision(legacy.data.review),
      gap: mapLegacyDecision(legacy.data.gap),
      reason: legacy.data.reason,
    };
  } catch {
    return fullTriageForTier(currentTier);
  }
};
