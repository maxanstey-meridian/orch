import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { homedir, tmpdir } from "os";
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

describe("run registry", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "run-registry-"));
  });

  afterEach(async () => {
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
});
