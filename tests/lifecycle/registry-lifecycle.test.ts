import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, afterEach } from "vitest";
import { readRegistry } from "#infrastructure/registry/run-registry.js";
import { registerRunLifecycle } from "../../src/main.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("registry lifecycle", () => {
  it("registry file is created on orchestration start", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orch-registry-lifecycle-"));
    const registryPath = join(tempDir, ".orch", "runs.json");

    const deregisterSelf = await registerRunLifecycle({
      registryPath,
      planId: "abc123",
      cwd: "/repo",
      planPath: "/repo/.orch/plan-abc123.json",
      statePath: "/repo/.orch/state/plan-abc123.json",
      branch: "feature/test",
    });

    const entries = await readRegistry(registryPath);

    expect(entries).toEqual([
      {
        id: "abc123",
        pid: process.pid,
        repo: "/repo",
        planPath: "/repo/.orch/plan-abc123.json",
        statePath: "/repo/.orch/state/plan-abc123.json",
        branch: "feature/test",
        startedAt: expect.any(String),
      },
    ]);
    expect(Number.isNaN(Date.parse(entries[0]!.startedAt))).toBe(false);

    await deregisterSelf();
  });

  it("registry entry is removed on clean exit", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orch-registry-signal-"));
    const registryPath = join(tempDir, ".orch", "runs.json");
    const deregisterSelf = await registerRunLifecycle({
      registryPath,
      planId: "abc123",
      cwd: "/repo",
      planPath: "/repo/.orch/plan-abc123.json",
      statePath: "/repo/.orch/state/plan-abc123.json",
    });

    await deregisterSelf();

    const entriesAfterExit = await readRegistry(registryPath);
    expect(entriesAfterExit).toEqual([]);
  });

  it("cleanup is idempotent when deregister is called twice", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orch-registry-idempotent-"));
    const registryPath = join(tempDir, ".orch", "runs.json");
    const deregisterSelf = await registerRunLifecycle({
      registryPath,
      planId: "abc123",
      cwd: "/repo",
      planPath: "/repo/.orch/plan-abc123.json",
      statePath: "/repo/.orch/state/plan-abc123.json",
    });

    await deregisterSelf();
    await deregisterSelf();

    const entriesAfterDoubleCleanup = await readRegistry(registryPath);
    expect(entriesAfterDoubleCleanup).toEqual([]);
  });
});
