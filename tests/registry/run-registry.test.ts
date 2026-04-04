import { spawn } from "child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEntry } from "#domain/registry.js";
import {
  defaultRegistryPath,
  deregisterRun,
  pruneDeadEntries,
  readRegistry,
  removeRunFromRegistry,
  registerRun,
  withRegistryLock,
  writeRegistry,
} from "#infrastructure/registry/run-registry.js";

type ChildProcessResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

type RunEntryOverrides = {
  readonly id?: string;
  readonly pid?: number;
  readonly repo?: string;
  readonly planPath?: string;
  readonly statePath?: string;
  readonly branch?: string;
  readonly startedAt?: string;
};

const makeEntry = (overrides: RunEntryOverrides = {}): RunEntry => {
  const {
    id = "run-1",
    pid = process.pid,
    repo = "/repos/orch",
    planPath = "/plans/plan.json",
    statePath = "/state/plan.json",
    branch,
    startedAt = "2026-04-01T12:00:00.000Z",
  } = overrides;

  return {
    id,
    pid,
    repo,
    planPath,
    statePath,
    startedAt,
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

const waitForRegistryLength = async (
  registryPath: string,
  expectedLength: number,
  timeoutMs = 5_000,
): Promise<RunEntry[]> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readRegistry(registryPath);
    if (entries.length === expectedLength) {
      return entries;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }

  return readRegistry(registryPath);
};

const registryModuleUrl = pathToFileURL(
  resolve(process.cwd(), "src/infrastructure/registry/run-registry.ts"),
).href;

const appendWorkerScript = `
const [moduleUrl, registryPath, entryJson] = process.argv.slice(1);
const { readRegistry, withRegistryLock, writeRegistry } = await import(moduleUrl);
const entry = JSON.parse(entryJson);

await withRegistryLock(registryPath, async () => {
  const entries = await readRegistry(registryPath);
  await writeRegistry(registryPath, [...entries, entry]);
});
`;

const readWorkerScript = `
const [moduleUrl, registryPath, minimumLengthText, iterationsText] = process.argv.slice(1);
const minimumLength = Number(minimumLengthText);
const iterations = Number(iterationsText);
const { readRegistry } = await import(moduleUrl);

for (let index = 0; index < iterations; index += 1) {
  const entries = await readRegistry(registryPath);
  if (entries.length < minimumLength) {
    console.error(\`Observed registry length \${entries.length} below minimum \${minimumLength}\`);
    process.exit(1);
  }
}
`;

describe("run registry", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "run-registry-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("readRegistry returns empty array when file does not exist", async () => {
    const registryPath = join(tempDir, "runs.json");

    await expect(readRegistry(registryPath)).resolves.toEqual([]);
  });

  it("defaultRegistryPath resolves ~/.orch/runs.json under the current home directory", () => {
    expect(defaultRegistryPath()).toBe(join(homedir(), ".orch", "runs.json"));
  });

  it("registerRun creates file and appends entry", async () => {
    const registryPath = join(tempDir, "runs.json");
    const entry = makeEntry();

    await registerRun(registryPath, entry);

    const raw = await readFile(registryPath, "utf8");
    expect(raw).toBe(JSON.stringify([entry], null, 2));
    await expect(readRegistry(registryPath)).resolves.toEqual([entry]);
  });

  it("registerRun appends to existing entries without clobbering", async () => {
    const registryPath = join(tempDir, "runs.json");
    const first = makeEntry({ id: "run-1", branch: "feature/a" });
    const second = makeEntry({ id: "run-2", pid: 22222, branch: "feature/b" });

    await registerRun(registryPath, first);
    await registerRun(registryPath, second);

    await expect(readRegistry(registryPath)).resolves.toEqual([first, second]);
  });

  it("cross-process locked appends preserve all entries and never expose empty reads", async () => {
    const registryPath = join(tempDir, "runs.json");
    const largeSuffix = "x".repeat(200_000);
    const baselineEntry = makeEntry({
      id: "run-0",
      planPath: `/plans/${largeSuffix}-0`,
    });
    const entries = Array.from({ length: 12 }, (_, index) =>
      makeEntry({
        id: `run-${index + 1}`,
        pid: 50_000 + index,
        planPath: `/plans/${largeSuffix}-${index + 1}`,
      }),
    );

    await writeFile(registryPath, JSON.stringify([baselineEntry], null, 2));

    const readerPromises = Array.from({ length: 6 }, () =>
      runNodeProcess([
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        readWorkerScript,
        registryModuleUrl,
        registryPath,
        "1",
        "200",
      ]),
    );
    const writerPromises = entries.map((entry) =>
      runNodeProcess([
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        appendWorkerScript,
        registryModuleUrl,
        registryPath,
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

    const actualEntries = await waitForRegistryLength(registryPath, entries.length + 1);
    expect(actualEntries).toHaveLength(entries.length + 1);
    expect(actualEntries.map((entry) => entry.id).sort()).toEqual(
      [baselineEntry, ...entries].map((entry) => entry.id).sort(),
    );
  }, 15_000);

  it("deregisterRun removes only the matching entry", async () => {
    const registryPath = join(tempDir, "runs.json");
    const first = makeEntry({ id: "run-1" });
    const second = makeEntry({ id: "run-2", pid: 33333 });

    await writeRegistry(registryPath, [first, second]);
    await deregisterRun(registryPath, first.id);

    await expect(readRegistry(registryPath)).resolves.toEqual([second]);
  });

  it("deregisterRun is a no-op when id not found", async () => {
    const registryPath = join(tempDir, "runs.json");
    const first = makeEntry({ id: "run-1" });
    const second = makeEntry({ id: "run-2", pid: 44444 });

    await writeRegistry(registryPath, [first, second]);
    await deregisterRun(registryPath, "missing");

    await expect(readRegistry(registryPath)).resolves.toEqual([first, second]);
  });

  it("readRegistry returns empty array on corrupt JSON", async () => {
    const registryPath = join(tempDir, "runs.json");
    await writeFile(registryPath, "{ definitely-not-json");

    await expect(readRegistry(registryPath)).resolves.toEqual([]);
  });

  it("readRegistry returns empty array when file contains a non-positive pid", async () => {
    const registryPath = join(tempDir, "runs.json");
    await writeFile(registryPath, JSON.stringify([makeEntry({ pid: 0 })]));

    await expect(readRegistry(registryPath)).resolves.toEqual([]);
  });

  it("readRegistry returns empty array when file contains a non-array JSON value", async () => {
    const registryPath = join(tempDir, "runs.json");
    await writeFile(registryPath, JSON.stringify({ id: "not-an-array" }));

    await expect(readRegistry(registryPath)).resolves.toEqual([]);
  });

  it("pruneDeadEntries separates alive from dead PIDs without deleting dead entries", async () => {
    const registryPath = join(tempDir, "runs.json");
    const aliveEntry = makeEntry({ id: "alive", pid: process.pid });
    const deadEntry = makeEntry({ id: "dead", pid: 999999 });

    await writeRegistry(registryPath, [aliveEntry, deadEntry]);

    const result = await pruneDeadEntries(registryPath);

    expect(result).toEqual({
      alive: [aliveEntry],
      dead: [deadEntry],
    });
    await expect(readRegistry(registryPath)).resolves.toEqual([aliveEntry, deadEntry]);
  });

  it("pruneDeadEntries keeps EPERM processes alive and marks ESRCH processes dead", async () => {
    const registryPath = join(tempDir, "runs.json");
    const epermEntry = makeEntry({ id: "eperm", pid: 424242 });
    const deadEntry = makeEntry({ id: "dead", pid: 999999 });

    await writeRegistry(registryPath, [epermEntry, deadEntry]);

    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal !== 0) {
        return true;
      }

      if (pid === epermEntry.pid) {
        const error = new Error("permission denied");
        Object.assign(error, { code: "EPERM" });
        throw error;
      }

      if (pid === deadEntry.pid) {
        const error = new Error("no such process");
        Object.assign(error, { code: "ESRCH" });
        throw error;
      }

      return true;
    });

    const result = await pruneDeadEntries(registryPath);

    expect(result).toEqual({
      alive: [epermEntry],
      dead: [deadEntry],
    });
  });

  it("writeRegistry creates parent directories if missing", async () => {
    const registryPath = join(tempDir, "nested", "registry", "runs.json");
    const entry = makeEntry();

    await writeRegistry(registryPath, [entry]);

    const raw = await readFile(registryPath, "utf8");
    expect(raw).toBe(JSON.stringify([entry], null, 2));
  });

  it("removeRunFromRegistry waits for a fresh lock directory without owner metadata", async () => {
    const registryPath = join(tempDir, "runs.json");
    const lockPath = `${registryPath}.lock`;
    const entry = makeEntry();
    let completed = false;

    await writeRegistry(registryPath, [entry]);
    await mkdir(lockPath, { recursive: true });

    const pending = removeRunFromRegistry(registryPath, entry.id).then(() => {
      completed = true;
    });

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });

    expect(completed).toBe(false);
    await expect(readRegistry(registryPath)).resolves.toEqual([entry]);

    await rm(lockPath, { force: true, recursive: true });
    await pending;

    await expect(readRegistry(registryPath)).resolves.toEqual([]);
  });

  it("withRegistryLock serializes removal after registration on the same registry path", async () => {
    const registryPath = join(tempDir, "runs.json");
    const existingEntry = makeEntry({ id: "existing" });
    const registeredEntry = makeEntry({ id: "registered", pid: 43210 });
    let resolveStarted!: () => void;
    const startedRegistration = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const registration = withRegistryLock(registryPath, async () => {
      await writeRegistry(registryPath, [existingEntry, registeredEntry]);
      resolveStarted();
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 25);
      });
    });

    await startedRegistration;

    await removeRunFromRegistry(registryPath, existingEntry.id);
    await registration;

    await expect(readRegistry(registryPath)).resolves.toEqual([registeredEntry]);
  });

  it("keeps an EPERM owner lock live until the directory is actually removed", async () => {
    const registryPath = join(tempDir, "runs.json");
    const lockPath = `${registryPath}.lock`;
    const ownerPid = 424242;
    let entered = false;

    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: ownerPid,
        acquiredAt: "2026-04-01T12:00:00.000Z",
      }),
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === ownerPid && signal === 0) {
        const error = new Error("permission denied");
        Object.assign(error, { code: "EPERM" });
        throw error;
      }

      return true;
    });

    const pending = withRegistryLock(registryPath, async () => {
      entered = true;
    });

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });

    expect(entered).toBe(false);

    await rm(lockPath, { force: true, recursive: true });
    await pending;

    expect(entered).toBe(true);
  });
});
