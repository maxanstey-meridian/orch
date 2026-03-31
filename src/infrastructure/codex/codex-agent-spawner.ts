import type { ChildProcess } from 'node:child_process';
import { AgentSpawner, type AgentHandle } from '../../application/ports/agent-spawner.port.js';
import type { AgentRole } from '../../domain/agent-types.js';
import { ROLE_STYLES } from '../claude-agent-spawner.js';
import { createCodexAppServerClient } from './codex-app-server-client.js';
import { detectQuestion } from '../agent/question-detector.js';
import { resolveCodexModeConfig } from './codex-mode-config.js';

type ProcessFactory = () => ChildProcess;

export class CodexAgentSpawner extends AgentSpawner {
  constructor(
    private readonly defaultCwd: string,
    private readonly config: { readonly auto: boolean; readonly noInteraction: boolean },
    private readonly processFactory: ProcessFactory,
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

    let sessionId = opts?.resumeSessionId ?? '';
    let persistentOnText: ((text: string) => void) | undefined;
    let persistentOnToolUse: ((summary: string) => void) | undefined;
    const pendingGuidance: string[] = [];

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
      get sessionId() { return sessionId; },
      style,
      get alive() { return client.alive; },
      get stderr() { return ''; },

      send: async (prompt, onText?, onToolUse?) => {
        try {
          await ready;

          let effectivePrompt = prompt;
          if (pendingGuidance.length > 0) {
            const guidance = pendingGuidance.splice(0).join('\n');
            effectivePrompt = `[Prior operator guidance — incorporate before proceeding]\n${guidance}\n[End prior guidance]\n\n${prompt}`;
          }

          let assistantText = '';
          let failed = false;
          const effectiveOnText = onText ?? persistentOnText;
          const effectiveOnToolUse = onToolUse ?? persistentOnToolUse;

          const resultText = await client.startTurn(effectivePrompt, (event) => {
            switch (event.kind) {
              case 'textDelta':
                assistantText += event.text;
                effectiveOnText?.(event.text);
                break;
              case 'toolActivity':
                effectiveOnToolUse?.(event.summary);
                break;
              case 'turnFailed':
                failed = true;
                assistantText += `\n[Error: ${event.error.code} — ${event.error.message}]`;
                break;
              case 'approvalRequested':
                if (modeConfig.approvalMode === 'auto-approve') {
                  client.respondToApproval(event.request.id, true);
                }
                break;
            }
          });

          return {
            exitCode: failed ? 1 : 0,
            assistantText,
            resultText,
            needsInput: detectQuestion(assistantText),
            sessionId,
          };
        } catch {
          return { exitCode: 1, assistantText: '', resultText: '', needsInput: false, sessionId };
        }
      },

      sendQuiet: async (prompt) => {
        try {
          await ready;

          let effectivePrompt = prompt;
          if (pendingGuidance.length > 0) {
            const guidance = pendingGuidance.splice(0).join('\n');
            effectivePrompt = `[Prior operator guidance — incorporate before proceeding]\n${guidance}\n[End prior guidance]\n\n${prompt}`;
          }

          const resultText = await client.startTurn(effectivePrompt, (event) => {
            if (event.kind === 'approvalRequested' && modeConfig.approvalMode === 'auto-approve') {
              client.respondToApproval(event.request.id, true);
            }
          });

          return resultText;
        } catch {
          return '';
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
