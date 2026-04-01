import { watch } from "fs";
import type { FSWatcher } from "fs";
import { open, readFile, stat } from "fs/promises";
import { useEffect, useState } from "react";

const maxLines = 500;
const watcherRetryMs = 100;
const missingLogPathError = "Log file not available";
const missingFileError = "Log file not found yet";

const isErrorWithCode = (value: unknown): value is { readonly code: string } =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  typeof value.code === "string";

const capLines = (lines: readonly string[]): string[] => lines.slice(-maxLines);

const splitLines = (content: string): string[] => {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
};

const readChunk = async (filePath: string, offset: number, length: number): Promise<string> => {
  const fileHandle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fileHandle.close();
  }
};

export const useLogTail = (
  logPath: string | undefined,
): { lines: string[]; error?: string } => {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (logPath === undefined) {
      setLines([]);
      setError(missingLogPathError);
      return;
    }

    let cancelled = false;
    let watcher: FSWatcher | undefined;
    let retryId: NodeJS.Timeout | undefined;
    let readInFlight = false;
    let readQueued = false;
    let offset = 0;

    const clearRetry = (): void => {
      if (retryId !== undefined) {
        clearInterval(retryId);
        retryId = undefined;
      }
    };

    const closeWatcher = (): void => {
      watcher?.close();
      watcher = undefined;
    };

    const scheduleRetry = (): void => {
      if (retryId !== undefined || cancelled) {
        return;
      }

      retryId = setInterval(() => {
        void ensureWatching();
      }, watcherRetryMs);
    };

    const loadFullFile = async (): Promise<boolean> => {
      try {
        const content = await readFile(logPath, "utf8");
        if (cancelled) {
          return false;
        }

        offset = Buffer.byteLength(content);
        setLines(capLines(splitLines(content)));
        setError(undefined);
        return true;
      } catch (readError) {
        if (cancelled) {
          return false;
        }

        if (isErrorWithCode(readError) && readError.code === "ENOENT") {
          setError(missingFileError);
          return false;
        }

        setError(readError instanceof Error ? readError.message : String(readError));
        return false;
      }
    };

    const readAppendedLines = async (): Promise<void> => {
      if (readInFlight) {
        readQueued = true;
        return;
      }

      readInFlight = true;

      try {
        do {
          readQueued = false;

          let fileStats;
          try {
            fileStats = await stat(logPath);
          } catch (statError) {
            if (cancelled) {
              return;
            }

            if (isErrorWithCode(statError) && statError.code === "ENOENT") {
              closeWatcher();
              setError(missingFileError);
              scheduleRetry();
              return;
            }

            setError(statError instanceof Error ? statError.message : String(statError));
            return;
          }

          if (fileStats.size < offset) {
            const loaded = await loadFullFile();
            if (!loaded) {
              scheduleRetry();
              return;
            }
            continue;
          }

          if (fileStats.size === offset) {
            continue;
          }

          try {
            const chunk = await readChunk(logPath, offset, fileStats.size - offset);
            if (cancelled) {
              return;
            }

            offset = fileStats.size;
            setLines((currentLines) => capLines([...currentLines, ...splitLines(chunk)]));
            setError(undefined);
          } catch (readError) {
            if (cancelled) {
              return;
            }

            if (isErrorWithCode(readError) && readError.code === "ENOENT") {
              closeWatcher();
              setError(missingFileError);
              scheduleRetry();
              return;
            }

            setError(readError instanceof Error ? readError.message : String(readError));
            return;
          }
        } while (readQueued);
      } finally {
        readInFlight = false;
      }
    };

    const ensureWatching = async (): Promise<void> => {
      if (cancelled || watcher !== undefined) {
        return;
      }

      const loaded = await loadFullFile();
      if (!loaded || cancelled) {
        scheduleRetry();
        return;
      }

      try {
        watcher = watch(logPath, () => {
          void readAppendedLines();
        });
        clearRetry();
        await readAppendedLines();
      } catch (watchError) {
        if (cancelled) {
          return;
        }

        if (isErrorWithCode(watchError) && watchError.code === "ENOENT") {
          setError(missingFileError);
          scheduleRetry();
          return;
        }

        setError(watchError instanceof Error ? watchError.message : String(watchError));
        scheduleRetry();
      }
    };

    void ensureWatching();

    return () => {
      cancelled = true;
      clearRetry();
      closeWatcher();
    };
  }, [logPath]);

  return { lines, error };
};
