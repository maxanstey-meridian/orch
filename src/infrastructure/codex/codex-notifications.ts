import type { JsonRpcNotification } from "./codex-json-rpc.js";

export type CodexTurnError = {
  readonly code: string;
  readonly message: string;
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
  | { readonly kind: "turnFailed"; readonly error: CodexTurnError }
  | { readonly kind: "approvalRequested"; readonly request: CodexApprovalRequest }
  | { readonly kind: "ignored" };

export const normalizeNotification = (n: JsonRpcNotification): CodexEvent => {
  const params = n.params;

  switch (n.method) {
    case "item/agentMessage/delta": {
      const delta = params?.delta;
      if (typeof delta === "string") return { kind: "textDelta", text: delta };
      return { kind: "ignored" };
    }
    case "codex/approvalRequest": {
      const validKinds = new Set(["command", "fileChange", "permission"]);
      const kind = params?.kind;
      if (typeof kind !== "string" || !validKinds.has(kind)) return { kind: "ignored" };
      return {
        kind: "approvalRequested",
        request: {
          id: String(params?.id ?? ""),
          kind: kind as CodexApprovalRequest["kind"],
          summary: String(params?.summary ?? ""),
        },
      };
    }
    case "item/commandExecution/requestApproval": {
      return {
        kind: "approvalRequested",
        request: {
          id: String(params?.itemId ?? ""),
          kind: "command" as const,
          summary: String(params?.reason ?? params?.command ?? ""),
        },
      };
    }
    case "item/fileChange/requestApproval": {
      return {
        kind: "approvalRequested",
        request: {
          id: String(params?.itemId ?? ""),
          kind: "fileChange" as const,
          summary: String(params?.reason ?? ""),
        },
      };
    }
    case "error": {
      return {
        kind: "turnFailed",
        error: {
          code: String(params?.code ?? "unknown"),
          message: String(params?.message ?? "unknown"),
        },
      };
    }
    case "turn/completed": {
      // Result text is accumulated from item/agentMessage/delta by the adapter — this is just a signal
      return { kind: "turnCompleted", resultText: "" };
    }
    case "item/started": {
      const item = params?.item as Record<string, unknown> | undefined;
      if (item?.type === "commandExecution") {
        return { kind: "toolActivity", summary: `Running: ${String(item.command ?? "unknown")}` };
      }
      if (item?.type === "fileChange") {
        const changes = item.changes as ReadonlyArray<{ path: string }> | undefined;
        const path = changes?.[0]?.path ?? "unknown";
        return { kind: "toolActivity", summary: `Editing: ${path}` };
      }
      return { kind: "ignored" };
    }
    case "item/completed": {
      const cmd = params?.commandExecution;
      if (typeof cmd === "object" && cmd !== null) {
        return {
          kind: "toolActivity",
          summary: `command: ${String((cmd as Record<string, unknown>).command ?? "unknown")}`,
        };
      }
      const fc = params?.fileChange;
      if (typeof fc === "object" && fc !== null) {
        return {
          kind: "toolActivity",
          summary: `file change: ${String((fc as Record<string, unknown>).path ?? "unknown")}`,
        };
      }
      const mcp = params?.mcpToolCall;
      if (typeof mcp === "object" && mcp !== null) {
        return {
          kind: "toolActivity",
          summary: `mcp tool: ${String((mcp as Record<string, unknown>).name ?? "unknown")}`,
        };
      }
      return { kind: "ignored" };
    }
    default:
      return { kind: "ignored" };
  }
};
