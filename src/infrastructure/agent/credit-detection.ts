import type { AgentResult } from "../../domain/agent-types.js";

export type CreditSignal = {
  readonly kind: "mid-response" | "rejected";
  readonly message: string;
};

type Pattern = {
  readonly test: (text: string) => boolean;
  readonly message: string;
};

const patterns: readonly Pattern[] = [
  { test: (t) => /rate\s+limit/i.test(t), message: "Rate limited. Wait and retry." },
  {
    test: (t) => /credit/i.test(t) && /(exhaust|limit|exceed)/i.test(t),
    message: "Credits exhausted.",
  },
  { test: (t) => /quota/i.test(t) && /(exceed|limit)/i.test(t), message: "Quota exceeded." },
  { test: (t) => /usage\s+limit/i.test(t), message: "Usage limit reached." },
];

export const detectCreditExhaustion = (
  result: AgentResult,
  stderr: string,
): CreditSignal | null => {
  const combined = `${result.resultText}\n${stderr}`;

  if (result.exitCode === 0) return null;

  const matched = patterns.find((p) => p.test(combined));
  if (!matched) return null;

  const kind = result.assistantText.length > 0 ? ("mid-response" as const) : ("rejected" as const);

  return { kind, message: matched.message };
};
