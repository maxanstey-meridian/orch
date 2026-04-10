import type { AgentRole, AgentStyle } from "#domain/agent-types.js";
import { BOT_FINAL, BOT_GAP, BOT_PLAN, BOT_REVIEW, BOT_TDD, BOT_VERIFY } from "./display.js";

export const ROLE_STYLES: Readonly<Record<AgentRole, AgentStyle>> = {
  tdd: BOT_TDD,
  review: BOT_REVIEW,
  verify: BOT_VERIFY,
  plan: BOT_PLAN,
  gap: BOT_GAP,
  final: BOT_FINAL,
  completeness: BOT_PLAN,
  triage: { label: "TRIAGE", color: "#888", badge: "[TRG]" },
};
