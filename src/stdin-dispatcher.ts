export type RawStdin = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void;
  unref?: () => void;
};

export type StdinDispatcher = {
  readonly subscribe: (handler: (chunk: Buffer) => void) => () => void;
  readonly dispose: () => void;
  readonly stdin: RawStdin;
};

type DispatcherIO = {
  readonly stdin: RawStdin;
};

export const createStdinDispatcher = (io?: DispatcherIO): StdinDispatcher => {
  const stdin: RawStdin = io?.stdin ?? process.stdin;
  const handlers = new Set<(chunk: Buffer) => void>();

  const onData = (chunk: Buffer) => {
    for (const handler of handlers) handler(chunk);
  };

  return {
    stdin,
    subscribe: (handler) => {
      handlers.add(handler);
      if (handlers.size === 1) {
        stdin.setRawMode?.(true);
        stdin.on("data", onData);
      }
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          stdin.removeListener("data", onData);
          stdin.setRawMode?.(false);
          stdin.unref?.();
        }
      };
    },
    dispose: () => {
      handlers.clear();
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.unref?.();
    },
  };
};
