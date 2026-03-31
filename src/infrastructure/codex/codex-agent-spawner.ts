import type { ChildProcess } from "node:child_process";
import { AgentSpawner, type AgentHandle } from "../../application/ports/agent-spawner.port.js";
import type { AgentRole } from "../../domain/agent-types.js";
import type {
  RuntimeInteractionGate,
  RuntimeInteractionRequest,
} from "../../application/ports/runtime-interaction.port.js";
import type { CodexApprovalRequest, CodexTurnError } from "./codex-notifications.js";
import { categorizeCodexError } from "./codex-error-mapper.js";
import { ROLE_STYLES } from "../../ui/agent-role-styles.js";
import { createCodexAppServerClient } from "./codex-app-server-client.js";
import { detectQuestion } from "../agent/question-detector.js";
import { resolveCodexModeConfig } from "./codex-mode-config.js";

const SENTENCE_END = /[a-z][.!?]\s*$/i;

const createTextBuffer = (flush: (text: string) => void) => {
  let buf = "";

  return {
    push: (text: string) => {
      buf += text;
      // Flush on newline — collapse runs of blank lines into one
      if (buf.includes("\n")) {
        const lastNewline = buf.lastIndexOf("\n");
        const chunk = buf.slice(0, lastNewline + 1).replace(/\n{3,}/g, "\n\n");
        flush(chunk);
        buf = buf.slice(lastNewline + 1);
        return;
      }
      // Flush on sentence boundary
      if (SENTENCE_END.test(buf)) {
        flush(buf);
        buf = "";
      }
    },
    flush: () => {
      if (buf) {
        flush(buf);
        buf = "";
      }
    },
  };
};

const errorToResultText = (error: CodexTurnError): string => {
  const category = categorizeCodexError(error);
  switch (category) {
    case "creditExhausted":
      return `Credit exhausted: ${error.message}`;
    case "retryable":
      return error.code === "rateLimited"
        ? `Rate limit exceeded: ${error.message}`
        : `Server overloaded: ${error.message}`;
    case "unauthorized":
      return `Unauthorized: ${error.message}`;
    case "unknown":
      return `Error: ${error.code} — ${error.message}`;
  }
};

type ProcessFactory = () => ChildProcess;

const mapApprovalToInteraction = (request: CodexApprovalRequest): RuntimeInteractionRequest => {
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
    },
  ): AgentHandle {
    const style = ROLE_STYLES[role];
    const modeConfig = resolveCodexModeConfig(role, this.config);
    const proc = this.processFactory();
    const client = createCodexAppServerClient(proc);

    let sessionId = opts?.resumeSessionId ?? "";
    let persistentOnText: ((text: string) => void) | undefined;
    let persistentOnToolUse: ((summary: string) => void) | undefined;
    const pendingGuidance: string[] = [];
    let approvalChain = Promise.resolve();

    const handleApprovalEvent = (request: CodexApprovalRequest) => {
      if (modeConfig.approvalMode === "auto-approve") {
        client.respondToApproval(request.id, true);
      } else {
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
            // Gate failure (e.g. hud crash) — reject the approval as fail-safe
            client.respondToApproval(request.id, false);
          }
        });
      }
    };

    const threadOpts = {
      developerInstructions: opts?.systemPrompt,
      sandbox: modeConfig.sandbox,
    };

    // Ready promise: initialize → start/resume thread
    const ready = (async () => {
      await client.initialize();
      if (opts?.resumeSessionId) {
        await client.resumeThread(opts.resumeSessionId, threadOpts);
      } else {
        sessionId = await client.startThread(threadOpts);
      }
    })();

    const handle: AgentHandle = {
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
            effectivePrompt = `[Prior operator guidance — incorporate before proceeding]\n${guidance}\n[End prior guidance]\n\n${prompt}`;
          }

          let assistantText = "";
          let failed = false;
          let failureResultText = "";
          const effectiveOnText = onText ?? persistentOnText;
          const effectiveOnToolUse = onToolUse ?? persistentOnToolUse;
          const textBuf = effectiveOnText ? createTextBuffer(effectiveOnText) : null;

          const resultText = await client.startTurn(effectivePrompt, (event) => {
            switch (event.kind) {
              case "textDelta":
                assistantText += event.text;
                textBuf?.push(event.text);
                break;
              case "toolActivity":
                effectiveOnToolUse?.(event.summary);
                break;
              case "turnFailed":
                failed = true;
                failureResultText = errorToResultText(event.error);
                assistantText += `\n[${failureResultText}]`;
                break;
              case "approvalRequested":
                handleApprovalEvent(event.request);
                break;
            }
          });

          textBuf?.flush();

          return {
            exitCode: failed ? 1 : 0,
            assistantText,
            resultText: failed ? failureResultText : resultText,
            needsInput: detectQuestion(assistantText),
            sessionId,
          };
        } catch {
          return { exitCode: 1, assistantText: "", resultText: "", needsInput: false, sessionId };
        }
      },

      sendQuiet: async (prompt) => {
        try {
          await ready;

          let effectivePrompt = prompt;
          if (pendingGuidance.length > 0) {
            const guidance = pendingGuidance.splice(0).join("\n");
            effectivePrompt = `[Prior operator guidance — incorporate before proceeding]\n${guidance}\n[End prior guidance]\n\n${prompt}`;
          }

          const resultText = await client.startTurn(effectivePrompt, (event) => {
            if (event.kind === "approvalRequested") {
              handleApprovalEvent(event.request);
            }
          });

          return resultText;
        } catch {
          return "";
        }
      },

      inject: (message) => {
        if (client.currentTurnId) {
          // Fire-and-forget: inject returns void but steerTurn is async
          client.steerTurn(message).catch(() => {});
        } else {
          pendingGuidance.push(message);
        }
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

    return handle;
  }
}
