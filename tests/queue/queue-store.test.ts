import { spawn } from "child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueueEntry } from "#domain/queue.js";
import {
  addToQueue,
  defaultQueuePath,
  dequeueNext,
  moveInQueue,
  readQueue,
  removeFromQueue,
} from "#infrastructure/queue/queue-store.js";

type ChildProcessResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

type QueueEntryOverrides = {
  readonly id?: string;
  readonly repo?: string;
  readonly planPath?: string;
  readonly branch?: string;
  readonly flags?: readonly string[];
  readonly addedAt?: string;
};

const makeEntry = (overrides: QueueEntryOverrides = {}): QueueEntry => {
  const {
    id = "queue-1",
    repo = "/repos/orch",
    planPath = "/plans/plan.json",
    branch,
    flags = ["--auto"],
    addedAt = "2026-04-03T12:00:00.000Z",
  } = overrides;

  return {
    id,
    repo,
    planPath,
    flags: [...flags],
    addedAt,
    ...(branch === undefined ? {} : { branch }),
  };
};

const runNodeProcess = async (
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<ChildProcessResult> => {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      resolvePromise({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
};

const waitForQueueLength = async (
  queuePath: string,
  expectedLength: number,
  timeoutMs = 5_000,
): Promise<QueueEntry[]> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readQueue(queuePath);
    if (entries.length === expectedLength) {
      return entries;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }

  return readQueue(queuePath);
};

const queueStoreModuleUrl = pathToFileURL(
  resolve(process.cwd(), "src/infrastructure/queue/queue-store.ts"),
).href;

const addWorkerScript = `
const [moduleUrl, queuePath, entryJson] = process.argv.slice(1);
const { addToQueue } = await import(moduleUrl);
await addToQueue(queuePath, JSON.parse(entryJson));
`;

const readWorkerScript = `
const [moduleUrl, queuePath, minimumLengthText, iterationsText] = process.argv.slice(1);
const minimumLength = Number(minimumLengthText);
const iterations = Number(iterationsText);
const { readQueue } = await import(moduleUrl);

for (let index = 0; index < iterations; index += 1) {
  const entries = await readQueue(queuePath);
  if (entries.length < minimumLength) {
    console.error(\`Observed queue length \${entries.length} below minimum \${minimumLength}\`);
    process.exit(1);
  }
}
`;

describe("queue store", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "queue-store-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("readQueue returns empty array when file missing", async () => {
    const queuePath = join(tempDir, "queue.json");

    await expect(readQueue(queuePath)).resolves.toEqual([]);
  });

  it("QueueEntry uses mutable fields and string[] flags", () => {
    const entry: QueueEntry = makeEntry();

    entry.id = "queue-2";
    entry.flags.push("--later");

    expect(entry.id).toBe("queue-2");
    expect(entry.flags).toEqual(["--auto", "--later"]);
  });

  it("defaultQueuePath resolves ~/.orch/queue.json under the current home directory", () => {
    expect(defaultQueuePath()).toBe(join(homedir(), ".orch", "queue.json"));
  });

  it("addToQueue creates file and adds entry", async () => {
    const queuePath = join(tempDir, "queue.json");
    const entry = makeEntry();

    await addToQueue(queuePath, entry);

    const raw = await readFile(queuePath, "utf8");
    expect(raw).toBe(JSON.stringify([entry], null, 2));
    await expect(readQueue(queuePath)).resolves.toEqual([entry]);
  });

  it("addToQueue appends in order", async () => {
    const queuePath = join(tempDir, "queue.json");
    const first = makeEntry({ id: "queue-1", branch: "feature/a", flags: ["--auto"] });
    const second = makeEntry({ id: "queue-2", branch: "feature/b", flags: ["--dry-run"] });

    await addToQueue(queuePath, first);
    await addToQueue(queuePath, second);

    await expect(readQueue(queuePath)).resolves.toEqual([first, second]);
  });

  it("addToQueue creates parent directories when missing", async () => {
    const queuePath = join(tempDir, "nested", "queue", "queue.json");
    const entry = makeEntry();

    await addToQueue(queuePath, entry);

    const raw = await readFile(queuePath, "utf8");
    expect(raw).toBe(JSON.stringify([entry], null, 2));
    await expect(readQueue(queuePath)).resolves.toEqual([entry]);
  });

  it("concurrent addToQueue calls do not lose queued entries", async () => {
    const queuePath = join(tempDir, "queue.json");
    const entries = Array.from({ length: 25 }, (_, index) =>
      makeEntry({
        id: `queue-${index + 1}`,
        flags: [`--flag-${index + 1}`],
      }),
    );

    await Promise.all(entries.map((entry) => addToQueue(queuePath, entry)));

    await expect(readQueue(queuePath)).resolves.toEqual(entries);
  });

  it("cross-process addToQueue calls preserve all entries and never expose empty reads", async () => {
    const queuePath = join(tempDir, "queue.json");
    const largeSuffix = "x".repeat(200_000);
    const baselineEntry = makeEntry({
      id: "queue-0",
      planPath: `/plans/${largeSuffix}-0`,
      flags: ["--baseline"],
    });
    const entries = Array.from({ length: 12 }, (_, index) =>
      makeEntry({
        id: `queue-${index + 1}`,
        planPath: `/plans/${largeSuffix}-${index + 1}`,
        flags: [`--flag-${index + 1}`],
      }),
    );

    await writeFile(queuePath, JSON.stringify([baselineEntry], null, 2));

    const readerPromises = Array.from({ length: 6 }, () =>
      runNodeProcess([
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        readWorkerScript,
        queueStoreModuleUrl,
        queuePath,
        "1",
        "200",
      ]),
    );
    const writerPromises = entries.map((entry) =>
      runNodeProcess([
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        addWorkerScript,
        queueStoreModuleUrl,
        queuePath,
        JSON.stringify(entry),
      ]),
    );

    const [readerResults, writerResults] = await Promise.all([
      Promise.all(readerPromises),
      Promise.all(writerPromises),
    ]);

    for (const result of readerResults) {
      expect(result).toEqual({
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    }

    for (const result of writerResults) {
      expect(result).toEqual({
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    }

    const actualEntries = await waitForQueueLength(queuePath, entries.length + 1);
    expect(actualEntries).toHaveLength(entries.length + 1);
    expect(actualEntries.map((entry) => entry.id).sort()).toEqual(
      [baselineEntry, ...entries].map((entry) => entry.id).sort(),
    );
  }, 15_000);

  it("addToQueue recovers from a legacy lock directory left behind by older implementations", async () => {
    const queuePath = join(tempDir, "queue.json");
    const entry = makeEntry({ id: "queue-1" });
    const lockPath = `${queuePath}.lock`;

    await mkdir(lockPath, { recursive: true });
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleDate, staleDate);

    const result = await runNodeProcess(
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        addWorkerScript,
        queueStoreModuleUrl,
        queuePath,
        JSON.stringify(entry),
      ],
      { timeoutMs: 300 },
    );

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    await expect(readQueue(queuePath)).resolves.toEqual([entry]);
  });

  it("addToQueue waits for a fresh lock directory without owner metadata", async () => {
    const queuePath = join(tempDir, "queue.json");
    const lockPath = `${queuePath}.lock`;
    const entry = makeEntry({ id: "queue-1" });
    let completed = false;

    await mkdir(lockPath, { recursive: true });

    const pending = addToQueue(queuePath, entry).then(() => {
      completed = true;
    });

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });

    expect(completed).toBe(false);
    await expect(readQueue(queuePath)).resolves.toEqual([]);

    await rm(lockPath, { recursive: true, force: true });
    await pending;

    await expect(readQueue(queuePath)).resolves.toEqual([entry]);
  });

  it("removeFromQueue removes only matching entry", async () => {
    const queuePath = join(tempDir, "queue.json");
    const first = makeEntry({ id: "queue-1" });
    const second = makeEntry({ id: "queue-2", flags: ["--interactive"] });

    await writeFile(queuePath, JSON.stringify([first, second], null, 2));
    await removeFromQueue(queuePath, first.id);

    await expect(readQueue(queuePath)).resolves.toEqual([second]);
  });

  it("removeFromQueue is no-op for unknown id", async () => {
    const queuePath = join(tempDir, "queue.json");
    const first = makeEntry({ id: "queue-1" });
    const second = makeEntry({ id: "queue-2", flags: ["--interactive"] });

    await writeFile(queuePath, JSON.stringify([first, second], null, 2));
    await removeFromQueue(queuePath, "missing");

    await expect(readQueue(queuePath)).resolves.toEqual([first, second]);
  });

  it("moveInQueue moves entry to specified position", async () => {
    const queuePath = join(tempDir, "queue.json");
    const first = makeEntry({ id: "queue-1" });
    const second = makeEntry({ id: "queue-2" });
    const third = makeEntry({ id: "queue-3" });

    await writeFile(queuePath, JSON.stringify([first, second, third], null, 2));
    await moveInQueue(queuePath, third.id, 1);

    await expect(readQueue(queuePath)).resolves.toEqual([first, third, second]);
  });

  it("moveInQueue clamps position to array bounds", async () => {
    const queuePath = join(tempDir, "queue.json");
    const first = makeEntry({ id: "queue-1" });
    const second = makeEntry({ id: "queue-2" });
    const third = makeEntry({ id: "queue-3" });

    await writeFile(queuePath, JSON.stringify([first, second, third], null, 2));
    await moveInQueue(queuePath, second.id, -10);
    await expect(readQueue(queuePath)).resolves.toEqual([second, first, third]);

    await moveInQueue(queuePath, second.id, 99);
    await expect(readQueue(queuePath)).resolves.toEqual([first, third, second]);
  });

  it("dequeueNext returns first entry and removes it from file", async () => {
    const queuePath = join(tempDir, "queue.json");
    const first = makeEntry({ id: "queue-1" });
    const second = makeEntry({ id: "queue-2" });

    await writeFile(queuePath, JSON.stringify([first, second], null, 2));

    await expect(dequeueNext(queuePath)).resolves.toEqual(first);
    await expect(readQueue(queuePath)).resolves.toEqual([second]);
  });

  it("dequeueNext returns undefined for empty queue", async () => {
    const queuePath = join(tempDir, "queue.json");

    await expect(dequeueNext(queuePath)).resolves.toBeUndefined();
    await expect(readQueue(queuePath)).resolves.toEqual([]);
  });

  it("readQueue returns empty array on corrupt JSON", async () => {
    const queuePath = join(tempDir, "queue.json");
    await writeFile(queuePath, "{ definitely-not-json");

    await expect(readQueue(queuePath)).resolves.toEqual([]);
  });

  it("readQueue returns empty array when file contains a malformed queue entry", async () => {
    const queuePath = join(tempDir, "queue.json");
    await writeFile(
      queuePath,
      JSON.stringify([
        {
          id: "queue-1",
          repo: "/repo",
          planPath: "/plan",
          flags: "oops",
          addedAt: "2026-04-03T12:00:00.000Z",
        },
      ]),
    );

    await expect(readQueue(queuePath)).resolves.toEqual([]);
  });

  it("addToQueue throws and preserves the file when the queue contains malformed entries", async () => {
    const queuePath = join(tempDir, "queue.json");
    const validEntry = makeEntry({ id: "queue-1" });
    const malformedFile = JSON.stringify([
      validEntry,
      {
        id: "broken",
        repo: "/repo",
        planPath: "/plan",
        flags: "oops",
        addedAt: "2026-04-03T12:00:00.000Z",
      },
    ]);
    await writeFile(queuePath, malformedFile);

    await expect(addToQueue(queuePath, makeEntry({ id: "queue-2" }))).rejects.toThrow(
      `Queue file is corrupt: ${queuePath}`,
    );
    await expect(readFile(queuePath, "utf8")).resolves.toBe(malformedFile);
  });

  it("removeFromQueue throws and preserves the file when the queue contains malformed entries", async () => {
    const queuePath = join(tempDir, "queue.json");
    const validEntry = makeEntry({ id: "queue-1" });
    const malformedFile = JSON.stringify([
      validEntry,
      {
        id: "broken",
        repo: "/repo",
        planPath: "/plan",
        flags: "oops",
        addedAt: "2026-04-03T12:00:00.000Z",
      },
    ]);
    await writeFile(queuePath, malformedFile);

    await expect(removeFromQueue(queuePath, validEntry.id)).rejects.toThrow(
      `Queue file is corrupt: ${queuePath}`,
    );
    await expect(readFile(queuePath, "utf8")).resolves.toBe(malformedFile);
  });

  it("moveInQueue throws and preserves the file when the queue contains malformed entries", async () => {
    const queuePath = join(tempDir, "queue.json");
    const validEntry = makeEntry({ id: "queue-1" });
    const malformedFile = JSON.stringify([
      validEntry,
      {
        id: "broken",
        repo: "/repo",
        planPath: "/plan",
        flags: "oops",
        addedAt: "2026-04-03T12:00:00.000Z",
      },
    ]);
    await writeFile(queuePath, malformedFile);

    await expect(moveInQueue(queuePath, validEntry.id, 0)).rejects.toThrow(
      `Queue file is corrupt: ${queuePath}`,
    );
    await expect(readFile(queuePath, "utf8")).resolves.toBe(malformedFile);
  });

  it("dequeueNext throws and preserves the file when the queue contains malformed entries", async () => {
    const queuePath = join(tempDir, "queue.json");
    const validEntry = makeEntry({ id: "queue-1" });
    const malformedFile = JSON.stringify([
      validEntry,
      {
        id: "broken",
        repo: "/repo",
        planPath: "/plan",
        flags: "oops",
        addedAt: "2026-04-03T12:00:00.000Z",
      },
    ]);
    await writeFile(queuePath, malformedFile);

    await expect(dequeueNext(queuePath)).rejects.toThrow(`Queue file is corrupt: ${queuePath}`);
    await expect(readFile(queuePath, "utf8")).resolves.toBe(malformedFile);
  });
});
