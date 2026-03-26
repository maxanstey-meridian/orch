import { type StdinDispatcher } from "./stdin-dispatcher.js";

export type SkipHandler = {
  readonly waitForSkip: () => Promise<boolean>;
  readonly cancel: () => void;
};

type SkipIO = {
  readonly dispatcher: StdinDispatcher;
  readonly suppress?: { readonly prompting: boolean };
};

export function createSkipHandler(enabled: false): SkipHandler;
export function createSkipHandler(enabled: true, io: SkipIO): SkipHandler;
export function createSkipHandler(enabled: boolean, io?: SkipIO): SkipHandler {
  if (!enabled) {
    return {
      waitForSkip: () => new Promise<boolean>(() => {}),
      cancel: () => {},
    };
  }

  if (!io) throw new Error("io is required when enabled");
  const { dispatcher, suppress } = io;
  let resolve: ((skipped: boolean) => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  return {
    waitForSkip: () => {
      return new Promise<boolean>((res) => {
        resolve = res;
        unsubscribe = dispatcher.subscribe((chunk: Buffer) => {
          if (chunk.includes(0x13) && !suppress?.prompting) {
            cleanup();
            res(true);
          }
        });
      });
    },
    cancel: () => {
      cleanup();
      if (resolve) {
        resolve(false);
        resolve = null;
      }
    },
  };
};
