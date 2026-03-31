import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createClaudeAgent as createAgent } from "#infrastructure/claude/claude-agent-process.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-plan-detect-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe("ExitPlanMode detection", () => {
  it("captures planText from ExitPlanMode tool_use with valid input.plan", async () => {
    const script = join(tempDir, "agent.sh");
    await writeFile(
      script,
      `#!/bin/sh
while IFS= read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"hello world"}}]}}'
  echo '{"type":"result","result":"done","duration_ms":100,"num_turns":1}'
done
`,
    );
    await chmod(script, 0o755);

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "plan", color: "yellow", badge: "P" },
    });

    const result = await agent.send("test");
    agent.kill();

    expect(result.planText).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("planText is undefined when no ExitPlanMode tool_use", async () => {
    const script = join(tempDir, "agent.sh");
    await writeFile(
      script,
      `#!/bin/sh
while IFS= read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"just text"}]}}'
  echo '{"type":"result","result":"done","duration_ms":100,"num_turns":1}'
done
`,
    );
    await chmod(script, 0o755);

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "plan", color: "yellow", badge: "P" },
    });

    const result = await agent.send("test");
    agent.kill();

    expect(result.planText).toBeUndefined();
    expect(result.assistantText).toBe("just text");
  });

  it("summarizeToolUse reports ExitPlanMode via onToolUse callback", async () => {
    const script = join(tempDir, "agent.sh");
    await writeFile(
      script,
      `#!/bin/sh
while IFS= read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"the plan"}}]}}'
  echo '{"type":"result","result":"done","duration_ms":100,"num_turns":1}'
done
`,
    );
    await chmod(script, 0o755);

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "plan", color: "yellow", badge: "P" },
    });

    const toolSummaries: string[] = [];
    await agent.send("test", undefined, (summary) => toolSummaries.push(summary));
    agent.kill();

    expect(toolSummaries).toContain("Plan ready");
  });

  it("planText is undefined when ExitPlanMode input.plan is missing", async () => {
    const script = join(tempDir, "agent.sh");
    await writeFile(
      script,
      `#!/bin/sh
while IFS= read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{}}]}}'
  echo '{"type":"result","result":"done","duration_ms":100,"num_turns":1}'
done
`,
    );
    await chmod(script, 0o755);

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "plan", color: "yellow", badge: "P" },
    });

    const result = await agent.send("test");
    agent.kill();

    expect(result.planText).toBeUndefined();
  });

  it("planText is undefined when ExitPlanMode input.plan is non-string", async () => {
    const script = join(tempDir, "agent.sh");
    await writeFile(
      script,
      `#!/bin/sh
while IFS= read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":42}}]}}'
  echo '{"type":"result","result":"done","duration_ms":100,"num_turns":1}'
done
`,
    );
    await chmod(script, 0o755);

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "plan", color: "yellow", badge: "P" },
    });

    const result = await agent.send("test");
    agent.kill();

    expect(result.planText).toBeUndefined();
  });
});
