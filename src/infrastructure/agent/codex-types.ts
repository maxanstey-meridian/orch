export type CodexSandbox = "read-only" | "workspace-write";

export type ThreadOptions = {
  readonly developerInstructions?: string;
  readonly sandbox?: CodexSandbox;
};

export type CodexApprovalRequest = {
  readonly id: string;
  readonly kind: "command" | "fileChange" | "permission";
  readonly summary: string;
};

export type CodexEvent =
  | { readonly kind: "textDelta"; readonly text: string }
  | { readonly kind: "toolActivity"; readonly summary: string }
  | { readonly kind: "turnCompleted"; readonly resultText: string }
  | { readonly kind: "turnFailed"; readonly message: string }
  | { readonly kind: "approvalRequested"; readonly request: CodexApprovalRequest }
  | { readonly kind: "ignored" };

type CodexNotification = {
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

const extractCommandSummary = (command: string): string => {
  const shellWrapped = command.match(/^\/bin\/[^\s]+\s+-\S+\s+(.+)$/)?.[1];
  const inner = shellWrapped ?? command;

  if (
    (inner.startsWith("'") && inner.endsWith("'")) ||
    (inner.startsWith('"') && inner.endsWith('"'))
  ) {
    return inner.slice(1, -1);
  }

  return inner;
};

export const normalizeCodexNotification = (notification: CodexNotification): CodexEvent => {
  const params = notification.params;

  switch (notification.method) {
    case "item/agentMessage/delta": {
      const delta = params?.delta;
      if (typeof delta === "string") {
        return { kind: "textDelta", text: delta };
      }
      return { kind: "ignored" };
    }
    case "codex/approvalRequest": {
      const validKinds = new Set(["command", "fileChange", "permission"]);
      const kind = params?.kind;
      if (typeof kind !== "string" || !validKinds.has(kind)) {
        return { kind: "ignored" };
      }

      return {
        kind: "approvalRequested",
        request: {
          id: String(params?.id ?? ""),
          kind: kind as CodexApprovalRequest["kind"],
          summary: String(params?.summary ?? ""),
        },
      };
    }
    case "item/commandExecution/requestApproval":
      return {
        kind: "approvalRequested",
        request: {
          id: String(params?.itemId ?? ""),
          kind: "command",
          summary: String(params?.reason ?? params?.command ?? ""),
        },
      };
    case "item/fileChange/requestApproval":
      return {
        kind: "approvalRequested",
        request: {
          id: String(params?.itemId ?? ""),
          kind: "fileChange",
          summary: String(params?.reason ?? ""),
        },
      };
    case "error":
      return { kind: "turnFailed", message: JSON.stringify(params ?? {}) };
    case "turn/completed":
      return { kind: "turnCompleted", resultText: "" };
    case "item/started": {
      const item = params?.item as Record<string, unknown> | undefined;
      if (item?.type === "commandExecution") {
        const command = extractCommandSummary(String(item.command ?? "unknown"));
        return { kind: "toolActivity", summary: `Running: ${command.slice(0, 80)}` };
      }
      if (item?.type === "fileChange") {
        const changes = item.changes as ReadonlyArray<{ path: string }> | undefined;
        return { kind: "toolActivity", summary: `Editing: ${changes?.[0]?.path ?? "unknown"}` };
      }
      return { kind: "ignored" };
    }
    case "item/completed": {
      const commandExecution = params?.commandExecution;
      if (typeof commandExecution === "object" && commandExecution !== null) {
        return {
          kind: "toolActivity",
          summary: `command: ${String((commandExecution as Record<string, unknown>).command ?? "unknown")}`,
        };
      }

      const fileChange = params?.fileChange;
      if (typeof fileChange === "object" && fileChange !== null) {
        return {
          kind: "toolActivity",
          summary: `file change: ${String((fileChange as Record<string, unknown>).path ?? "unknown")}`,
        };
      }

      const mcpToolCall = params?.mcpToolCall;
      if (typeof mcpToolCall === "object" && mcpToolCall !== null) {
        return {
          kind: "toolActivity",
          summary: `mcp tool: ${String((mcpToolCall as Record<string, unknown>).name ?? "unknown")}`,
        };
      }

      return { kind: "ignored" };
    }
    default:
      return { kind: "ignored" };
  }
};
