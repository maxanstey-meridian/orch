import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createAgent } from "../src/agent.js";

const makeScript = async (dir: string, name: string, body: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-plan-detect-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe("ExitPlanMode detection", () => {
  it("captures planText from ExitPlanMode tool_use with valid input.plan", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"# My Plan\\nStep 1\\nStep 2"}}]}}\'',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "plan", color: "yellow", badge: "P" },
    });

    const result = await agent.send("generate plan");
    expect(result.planText).toBe("# My Plan\nStep 1\nStep 2");

    agent.kill();
  });
});
