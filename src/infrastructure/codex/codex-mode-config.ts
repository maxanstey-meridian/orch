import type { AgentRole } from "../../domain/agent-types.js";

export type CodexModeConfig = {
  readonly sandbox: "read-only" | "workspace-write";
  readonly approvalMode: "auto-approve" | "interactive";
};

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set(["plan", "gap", "completeness"]);

export const resolveCodexModeConfig = (
  role: AgentRole,
  config: { readonly auto: boolean },
): CodexModeConfig => ({
  sandbox: READ_ONLY_ROLES.has(role) ? "read-only" : "workspace-write",
  approvalMode: config.auto ? "auto-approve" : "interactive",
});
