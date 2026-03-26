import { createInterface } from "readline";
import { type StdinDispatcher } from "./stdin-dispatcher.js";

export type InterruptHandler = {
  readonly enable: () => void;
  readonly disable: () => void;
  readonly onInterrupt: (callback: (message: string) => void) => void;
  readonly prompting: boolean;
};

type InterruptIO = {
  readonly dispatcher: StdinDispatcher;
  readonly stdout: NodeJS.WritableStream;
};

export function createInterruptHandler(noInteraction: true): InterruptHandler;
export function createInterruptHandler(noInteraction: false, io: InterruptIO): InterruptHandler;
export function createInterruptHandler(noInteraction: boolean, io?: InterruptIO): InterruptHandler {
  if (noInteraction) {
    return {
      enable: () => {},
      disable: () => {},
      onInterrupt: () => {},
      get prompting() { return false; },
    };
  }

  if (!io) throw new Error("io is required when noInteraction is false");
  const { dispatcher, stdout } = io;
  const stdin = dispatcher.stdin;
  let callback: ((message: string) => void) | null = null;
  let listening = false;
  let prompting = false;
  let activeRl: ReturnType<typeof createInterface> | null = null;
  let unsubscribe: (() => void) | null = null;

  const onData = (chunk: Buffer) => {
    if (chunk.includes(0x07) && !prompting) {
      prompting = true;
      const rl = createInterface({ input: stdin, output: stdout });
      activeRl = rl;
      rl.question("\n[Interrupt] Enter guidance for the agent: ", (answer: string) => {
        rl.close();
        activeRl = null;
        prompting = false;
        // Strip control characters (e.g. stale 0x07 from repeated Ctrl+G)
        const trimmed = answer.replace(/[\x00-\x1f]/g, "").trim();
        if (trimmed) {
          if (callback) callback(trimmed);
        } else {
          stdout.write("Cancelled.\n");
        }
      });
    }
  };

  return {
    get prompting() { return prompting; },
    enable: () => {
      if (listening) return;
      listening = true;
      unsubscribe = dispatcher.subscribe(onData);
    },
    disable: () => {
      if (!listening) return;
      listening = false;
      if (activeRl) {
        activeRl.close();
        activeRl = null;
        prompting = false;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    onInterrupt: (cb: (message: string) => void) => {
      callback = cb;
    },
  };
};
