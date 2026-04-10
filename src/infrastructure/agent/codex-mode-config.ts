import type { AgentRole } from "#domain/agent-types.js";
import type { CodexSandbox } from "#infrastructure/agent/codex-types.js";

export type CodexModeConfig = {
  readonly sandbox: CodexSandbox;
  readonly approvalMode: "auto-approve" | "interactive";
};

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set([
  "plan",
  "gap",
  "completeness",
  "triage",
]);

export const resolveCodexModeConfig = (
  role: AgentRole,
  config: { readonly auto: boolean },
  planMode = false,
): CodexModeConfig => ({
  sandbox: planMode || READ_ONLY_ROLES.has(role) ? "read-only" : "workspace-write",
  approvalMode: config.auto ? "auto-approve" : "interactive",
});
