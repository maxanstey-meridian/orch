import { z } from "zod";
import { COMPLEXITY_TRIAGE_FALLBACK, type ComplexityTriageResult } from "#domain/triage.js";

const complexityTriageSchema = z
  .object({
    tier: z.enum(["trivial", "small", "medium", "large"]),
    reason: z.string().trim().min(1),
  })
  .strict();

const buildFallbackReason = (detail: string): string =>
  `${COMPLEXITY_TRIAGE_FALLBACK.reason}: ${detail}`;

export const parseComplexityTriageResult = (text: string): ComplexityTriageResult => {
  if (text.trim().length === 0) {
    return {
      tier: COMPLEXITY_TRIAGE_FALLBACK.tier,
      reason: buildFallbackReason("empty response"),
    };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const result = complexityTriageSchema.safeParse(parsed);
    if (!result.success) {
      return {
        tier: COMPLEXITY_TRIAGE_FALLBACK.tier,
        reason: buildFallbackReason("invalid schema"),
      };
    }
    return result.data;
  } catch {
    return {
      tier: COMPLEXITY_TRIAGE_FALLBACK.tier,
      reason: buildFallbackReason("invalid JSON"),
    };
  }
};

export const buildComplexityTriagePrompt = (requestContent: string): string => `You are classifying the complexity of an operator request before orchestration starts.

Choose exactly one tier:
- trivial: single-file change, mechanical transformation, config edit, tiny bug fix. Under ~50 lines of production code.
- small: a few files, one clear abstraction, straightforward implementation. Roughly 50-200 lines.
- medium: multiple files, new abstractions or dependencies, meaningful test surface. Roughly 200-800 lines.
- large: broad change surface, multiple subsystems, complex dependency ordering, significant test infrastructure. 800+ lines.

Multi-step structure alone does not mean complex — if the total implementation is small, classify it as small or trivial regardless of how many logical steps the request describes. Err toward smaller tiers when in doubt.

Return a JSON object with exactly these keys:
- "tier": one of "trivial", "small", "medium", "large"
- "reason": a short concrete reason

Output ONLY raw JSON. No markdown, no prose, no code fences, no surrounding text.

## Request
${requestContent}`;
