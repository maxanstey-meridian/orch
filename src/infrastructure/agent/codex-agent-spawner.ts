import type { ChildProcess } from "node:child_process";
import { AgentSpawner, type AgentHandle } from "#application/ports/agent-spawner.port.js";
import type {
  RuntimeInteractionGate,
  RuntimeInteractionRequest,
} from "#application/ports/runtime-interaction.port.js";
import type { AgentRole } from "#domain/agent-types.js";
import { ROLE_STYLES } from "#infrastructure/agent/claude-agent-spawner.js";
import { createCodexAppServerClient } from "#infrastructure/agent/codex-app-server-client.js";
import { resolveCodexModeConfig } from "#infrastructure/agent/codex-mode-config.js";
import type { CodexApprovalRequest } from "#infrastructure/agent/codex-types.js";
import { detectQuestion } from "#infrastructure/agent/question-detector.js";

const SENTENCE_END = /[a-z][.!?]\s*$/i;

type ProcessFactory = () => ChildProcess;

const createTextBuffer = (flush: (text: string) => void) => {
  let buffer = "";
  let trimLeadingWhitespaceOnNextPush = false;

  return {
    push: (incomingText: string) => {
      let text = incomingText;

      if (trimLeadingWhitespaceOnNextPush) {
        if (/^[ \t]+$/.test(text)) {
          return;
        }
        text = text.replace(/^[ \t]+/, "");
        trimLeadingWhitespaceOnNextPush = false;
      }

      buffer += text;
      if (buffer.includes("\n")) {
        const lastNewline = buffer.lastIndexOf("\n");
        const chunk = buffer.slice(0, lastNewline + 1).replace(/\n{3,}/g, "\n\n");
        flush(chunk);
        buffer = buffer.slice(lastNewline + 1);
        trimLeadingWhitespaceOnNextPush = false;
        return;
      }

      if (SENTENCE_END.test(buffer)) {
        flush(buffer);
        buffer = "";
        trimLeadingWhitespaceOnNextPush = true;
      }
    },
    flush: () => {
      if (!buffer) {
        return;
      }
      flush(buffer);
      buffer = "";
    },
  };
};

const mapApprovalToInteraction = (
  request: CodexApprovalRequest,
): RuntimeInteractionRequest => {
  switch (request.kind) {
    case "command":
      return { kind: "commandApproval", summary: request.summary, command: request.summary };
    case "fileChange":
      return { kind: "fileChangeApproval", summary: request.summary, files: [] };
    case "permission":
      return { kind: "permissionApproval", summary: request.summary };
  }
};

export class CodexAgentSpawner extends AgentSpawner {
  constructor(
    private readonly defaultCwd: string,
    private readonly config: { readonly auto: boolean },
    private readonly processFactory: ProcessFactory,
    private readonly gate: RuntimeInteractionGate,
  ) {
    super();
  }

  spawn(
    role: AgentRole,
    opts?: {
      readonly resumeSessionId?: string;
      readonly systemPrompt?: string;
      readonly cwd?: string;
      readonly planMode?: boolean;
      readonly model?: string;
    },
  ): AgentHandle {
    void (opts?.cwd ?? this.defaultCwd);
    const style = ROLE_STYLES[role];
    const modeConfig = resolveCodexModeConfig(role, this.config, opts?.planMode ?? false);
    const client = createCodexAppServerClient(this.processFactory());

    let sessionId = opts?.resumeSessionId ?? "";
    let persistentOnText: ((text: string) => void) | undefined;
    let persistentOnToolUse: ((summary: string) => void) | undefined;
    const pendingGuidance: string[] = [];
    let approvalChain = Promise.resolve();

    const handleApprovalEvent = (request: CodexApprovalRequest) => {
      if (modeConfig.approvalMode === "auto-approve") {
        client.respondToApproval(request.id, true);
        return;
      }

      approvalChain = approvalChain.then(async () => {
        try {
          const decision = await this.gate.decide(mapApprovalToInteraction(request));
          switch (decision.kind) {
            case "approve":
              client.respondToApproval(request.id, true);
              break;
            case "reject":
              client.respondToApproval(request.id, false);
              break;
            case "cancel":
              client.interruptTurn().catch(() => {});
              break;
          }
        } catch {
          client.respondToApproval(request.id, false);
        }
      });
    };

    const threadOptions = {
      developerInstructions: opts?.systemPrompt,
      sandbox: modeConfig.sandbox,
    };

    const ready = (async () => {
      await client.initialize();
      if (opts?.resumeSessionId) {
        await client.resumeThread(opts.resumeSessionId, threadOptions);
        return;
      }

      sessionId = await client.startThread(threadOptions);
    })();

    return {
      get sessionId() {
        return sessionId;
      },
      style,
      get alive() {
        return client.alive;
      },
      get stderr() {
        return "";
      },
      send: async (prompt, onText?, onToolUse?) => {
        try {
          await ready;

          let effectivePrompt = prompt;
          if (pendingGuidance.length > 0) {
            const guidance = pendingGuidance.splice(0).join("\n");
            effectivePrompt =
              `[Prior operator guidance - incorporate before proceeding]\n${guidance}` +
              `\n[End prior guidance]\n\n${prompt}`;
          }

          let assistantText = "";
          let failed = false;
          let failureResultText = "";
          const effectiveOnText = onText ?? persistentOnText;
          const effectiveOnToolUse = onToolUse ?? persistentOnToolUse;
          const textBuffer = effectiveOnText ? createTextBuffer(effectiveOnText) : null;

          const resultText = await client.startTurn(effectivePrompt, (event) => {
            switch (event.kind) {
              case "textDelta":
                assistantText += event.text;
                textBuffer?.push(event.text);
                break;
              case "toolActivity":
                effectiveOnToolUse?.(event.summary);
                break;
              case "turnFailed":
                failed = true;
                failureResultText = event.message;
                assistantText += `\n[${failureResultText}]`;
                break;
              case "approvalRequested":
                handleApprovalEvent(event.request);
                break;
              case "ignored":
              case "turnCompleted":
                break;
            }
          });

          textBuffer?.flush();

          return {
            exitCode: failed ? 1 : 0,
            assistantText,
            resultText: failed ? failureResultText : resultText,
            needsInput: detectQuestion(assistantText),
            sessionId,
          };
        } catch {
          return {
            exitCode: 1,
            assistantText: "",
            resultText: "",
            needsInput: false,
            sessionId,
          };
        }
      },
      sendQuiet: async (prompt) => {
        await ready;

        let effectivePrompt = prompt;
        if (pendingGuidance.length > 0) {
          const guidance = pendingGuidance.splice(0).join("\n");
          effectivePrompt =
            `[Prior operator guidance - incorporate before proceeding]\n${guidance}` +
            `\n[End prior guidance]\n\n${prompt}`;
        }

        let turnFailure: string | null = null;

        const resultText = await client.startTurn(effectivePrompt, (event) => {
          if (event.kind === "approvalRequested") {
            handleApprovalEvent(event.request);
            return;
          }
          if (event.kind === "turnFailed") {
            turnFailure = event.message;
          }
        });

        if (turnFailure !== null) {
          throw new Error(turnFailure);
        }

        return resultText;
      },
      inject: (message) => {
        if (client.currentTurnId) {
          client.steerTurn(message).catch(() => {});
          return;
        }

        pendingGuidance.push(message);
      },
      kill: () => {
        if (client.currentTurnId) {
          client.interruptTurn().catch(() => {});
        }
        client.close();
      },
      pipe: (onText, onToolUse) => {
        persistentOnText = onText;
        persistentOnToolUse = onToolUse;
      },
    };
  }
}
