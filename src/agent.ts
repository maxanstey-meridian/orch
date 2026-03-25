import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { detectQuestion } from './question-detector.js';

export type AgentStyle = {
  readonly label: string;
  readonly color: string;
  readonly badge: string;
};

export type AgentResult = {
  readonly exitCode: number;
  readonly assistantText: string;
  readonly resultText: string;
  readonly needsInput: boolean;
  readonly sessionId: string;
};

export type AgentOptions = {
  readonly prompt: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly sessionId?: string;
  readonly style: AgentStyle;
};

type AssistantEvent = {
  readonly type: 'assistant';
  readonly message: { readonly content: readonly { readonly type: string; readonly text?: string }[] };
};

type ResultEvent = {
  readonly type: 'result';
  readonly result: string;
  readonly duration_ms: number;
  readonly num_turns: number;
};

type StreamEvent = AssistantEvent | ResultEvent;

const parseEvent = (line: string): StreamEvent | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    if (obj.type === 'assistant') {
      const msg = obj.message;
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
      const content = (msg as Record<string, unknown>).content;
      if (!Array.isArray(content)) return null;
      return parsed as StreamEvent;
    }

    if (obj.type === 'result') return parsed as StreamEvent;

    return null;
  } catch {
    return null;
  }
};

const forEachEvent = (
  stdout: Readable,
  onEvent: (event: StreamEvent) => void,
): { flush: () => void } => {
  let buffer = '';

  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseEvent(line);
      if (event) onEvent(event);
    }
  });

  return {
    flush: () => {
      if (buffer.trim()) {
        const event = parseEvent(buffer);
        if (event) onEvent(event);
      }
    },
  };
};

const spawnAgent = (command: string, args: readonly string[], prompt: string) =>
  spawn(command, [...args, prompt], { stdio: ['inherit', 'pipe', 'pipe'] });

export const runAgent = async (opts: AgentOptions): Promise<AgentResult> => {
  const sessionId = opts.sessionId ?? randomUUID();
  const assistantChunks: string[] = [];
  let resultText = '';

  return new Promise<AgentResult>((resolve) => {
    const proc = spawnAgent(opts.command, opts.args, opts.prompt);

    const { flush } = forEachEvent(proc.stdout!, (event) => {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            assistantChunks.push(block.text);
          }
        }
      } else if (event.type === 'result') {
        resultText = typeof event.result === 'string' ? event.result : '';
      }
    });

    proc.on('close', (code: number | null) => {
      flush();
      const assistantText = assistantChunks.join('');
      resolve({
        exitCode: code ?? 1,
        assistantText,
        resultText,
        needsInput: detectQuestion(assistantText),
        sessionId,
      });
    });
  });
};

export const runAgentQuiet = async (opts: {
  readonly prompt: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly sessionId: string;
}): Promise<string> => {
  return new Promise<string>((resolve) => {
    const proc = spawnAgent(opts.command, opts.args, opts.prompt);
    let resultText = '';

    const { flush } = forEachEvent(proc.stdout!, (event) => {
      if (event.type === 'result') {
        resultText = typeof event.result === 'string' ? event.result : '';
      }
    });

    proc.on('close', () => {
      flush();
      resolve(resultText);
    });
  });
};
