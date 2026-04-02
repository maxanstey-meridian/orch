import { z } from "zod";
import {
  REQUEST_TRIAGE_FALLBACK,
  type RequestTriageResult,
} from "#domain/triage.js";

const requestTriageResultSchema = z.object({
  mode: z.enum(["direct", "grouped", "sliced"]),
  reason: z.string().trim().min(1),
});

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
- direct: the request is a bounded local change with narrow breadth of change, little dependency ordering, and no real resume value from splitting it further.
- grouped: the request spans multiple related changes with dependency ordering or meaningful intermediate units, but it still benefits from being executed as grouped milestones rather than fine-grained slices.
- sliced: the request has broad change surface, non-trivial dependency ordering, or strong slice-granularity resume value such that small resumable slices are materially useful.

Return a JSON object with exactly these keys:
- "mode": one of "direct", "grouped", or "sliced"
- "reason": a short concrete reason

Output ONLY raw JSON. No markdown, no prose, no code fences, no surrounding text.

## Request
${requestContent}`;
