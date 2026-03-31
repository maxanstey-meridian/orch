import type { AgentRole, AgentStyle } from "../domain/agent-types.js";
import { BOT_TDD, BOT_REVIEW, BOT_VERIFY, BOT_PLAN, BOT_GAP, BOT_FINAL } from "./display.js";

export const ROLE_STYLES: Readonly<Record<AgentRole, AgentStyle>> = {
  tdd: BOT_TDD,
  review: BOT_REVIEW,
  verify: BOT_VERIFY,
  plan: BOT_PLAN,
  gap: BOT_GAP,
  final: BOT_FINAL,
  completeness: BOT_PLAN,
  triage: { label: "Triage", color: "#888", badge: "[TRG]" },
};
