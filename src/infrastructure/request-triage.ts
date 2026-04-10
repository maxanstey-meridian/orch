import { z } from "zod";
import { REQUEST_TRIAGE_FALLBACK, type RequestTriageResult } from "#domain/triage.js";

const requestTriageResultSchema = z
  .object({
    mode: z.enum(["direct", "grouped", "sliced"]),
    reason: z.string().trim().min(1),
  })
  .strict();

const buildFallbackReason = (detail: string): string =>
  `${REQUEST_TRIAGE_FALLBACK.reason}: ${detail}`;

export const parseRequestTriageResult = (text: string): RequestTriageResult => {
  if (text.trim().length === 0) {
    return {
      mode: REQUEST_TRIAGE_FALLBACK.mode,
      reason: buildFallbackReason("empty response"),
    };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const result = requestTriageResultSchema.safeParse(parsed);
    if (!result.success) {
      return {
        mode: REQUEST_TRIAGE_FALLBACK.mode,
        reason: buildFallbackReason("invalid schema"),
      };
    }
    return result.data;
  } catch {
    return {
      mode: REQUEST_TRIAGE_FALLBACK.mode,
      reason: buildFallbackReason("invalid JSON"),
    };
  }
};

export const buildRequestTriagePrompt = (requestContent: string): string => `You are classifying an operator request before orchestration starts.

Choose exactly one execution mode:
- direct: the total implementation is small (roughly under ~200 lines of production code, few files, no new abstractions or dependencies). Multi-step structure alone does not disqualify direct — if the whole thing is trivially small, it is direct regardless of how many logical steps the request describes. Err toward direct when in doubt.
- grouped: the request spans multiple related changes that are individually non-trivial, with dependency ordering or meaningful intermediate deliverables, but it still benefits from grouped milestones rather than fine-grained slices.
- sliced: the request has broad change surface across many files, non-trivial dependency ordering between substantial pieces of work, or strong slice-granularity resume value such that small resumable slices are materially useful. Only use sliced when the work genuinely benefits from per-slice checkpointing.

Return a JSON object with exactly these keys:
- "mode": one of "direct", "grouped", or "sliced"
- "reason": a short concrete reason

Output ONLY raw JSON. No markdown, no prose, no code fences, no surrounding text.

## Request
${requestContent}`;
