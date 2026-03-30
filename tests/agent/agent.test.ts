import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createAgent } from "../../src/infrastructure/agent/agent.js";

const makeScript = async (dir: string, name: string, body: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-agent-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe("createAgent + send", () => {
  it("parses assistant and result events into structured result", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world."}]}}\'',
        '  echo \'{"type":"result","result":"Done.","duration_ms":1500,"num_turns":2}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test prompt");

    expect(result.exitCode).toBe(0);
    expect(result.assistantText).toBe("Hello world.");
    expect(result.resultText).toBe("Done.");
    expect(result.needsInput).toBe(false);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    agent.kill();
  });

  it("uses provided session ID", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      sessionId: "existing-session-123",
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.sessionId).toBe("existing-session-123");

    agent.kill();
  });

  it("accumulates text from multiple assistant events", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"First block. "}]}}\'',
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"Second block."}]}}\'',
        '  echo \'{"type":"result","result":"done","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.assistantText).toBe("First block. Second block.");

    agent.kill();
  });

  it("silently ignores malformed JSON lines", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo "not json at all"',
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"good line"}]}}\'',
        '  echo "{broken json"',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.assistantText).toBe("good line");
    expect(result.resultText).toBe("ok");

    agent.kill();
  });

  it("sets needsInput when assistant text ends with a question", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"Should I proceed with this?"}]}}\'',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.needsInput).toBe(true);

    agent.kill();
  });

  it("ignores structurally invalid assistant events", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":"not-an-object"}\'',
        '  echo \'{"type":"assistant","message":{"content":"not-an-array"}}\'',
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"valid"}]}}\'',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.assistantText).toBe("valid");

    agent.kill();
  });

  it("sends a second message to the same persistent process", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "COUNT=0",
        "while IFS= read -r line; do",
        "  COUNT=$((COUNT + 1))",
        '  echo "{\\\"type\\\":\\\"assistant\\\",\\\"message\\\":{\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"reply $COUNT\\\"}]}}"',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const r1 = await agent.send("first");
    expect(r1.assistantText).toBe("reply 1");

    const r2 = await agent.send("second");
    expect(r2.assistantText).toBe("reply 2");

    agent.kill();
  });

  it("reports alive true while running and false after kill", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    expect(agent.alive).toBe(true);

    agent.kill();
    // Wait a tick for the close event to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(agent.alive).toBe(false);
  });

  it("resolves with exitCode 1 if process dies mid-message", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "IFS= read -r line",
        'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\'',
        "exit 1",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.exitCode).toBe(1);
    expect(result.assistantText).toBe("partial");
    expect(result.needsInput).toBe(false);
  });

  it("resolves with exitCode 1 when send called on dead process", async () => {
    const script = await makeScript(tempDir, "agent.sh", "exit 0");

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    // Wait for process to exit
    const waitForDeath = async () => {
      for (let i = 0; i < 50; i++) {
        if (!agent.alive) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitForDeath();

    expect(agent.alive).toBe(false);
    const result = await agent.send("test");
    expect(result.exitCode).toBe(1);
  });

  it("returns empty resultText when result event has non-string result field", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"result","result":42,"duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.resultText).toBe("");
    expect(result.exitCode).toBe(0);

    agent.kill();
  });

  it("accumulates text from multiple content blocks within a single assistant event", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"block1 "},{"type":"text","text":"block2"}]}}\'',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.assistantText).toBe("block1 block2");

    agent.kill();
  });

  it("ignores non-text content blocks and only captures text blocks", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1"},{"type":"text","text":"kept"},{"type":"image","url":"x"}]}}\'',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.assistantText).toBe("kept");

    agent.kill();
  });

  it("parses event from final line that lacks a trailing newline before process exits", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "IFS= read -r line",
        'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"flushed"}]}}\'',
        'printf \'{"type":"result","result":"final","duration_ms":100,"num_turns":1}\'',
        "exit 0",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.assistantText).toBe("flushed");
    expect(result.resultText).toBe("final");
  });

  it("writes correct NDJSON format to process stdin", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "IFS= read -r line",
        'echo "$line" > "$0.stdin.log"',
        'echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "exit 0",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      sessionId: "test-session-abc",
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    await agent.send("hello world");

    const { readFile } = await import("fs/promises");
    const logged = await readFile(`${script}.stdin.log`, "utf-8");
    const parsed = JSON.parse(logged.trim());

    expect(parsed).toEqual({
      type: "user",
      message: { role: "user", content: "hello world" },
      session_id: "test-session-abc",
    });
  });

  it("does not throw when kill() is called twice", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    agent.kill();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agent.alive).toBe(false);

    // Second kill should not throw
    expect(() => agent.kill()).not.toThrow();
  });

  it("buffers stderr output from the child process", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo "stderr line 1" >&2',
        '  echo "stderr line 2" >&2',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    await agent.send("test");
    expect(agent.stderr).toContain("stderr line 1");
    expect(agent.stderr).toContain("stderr line 2");

    agent.kill();
  });

  it("resolves send with exitCode 1 when spawned command does not exist", async () => {
    const agent = createAgent({
      command: "/nonexistent/command/that/does/not/exist",
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.send("test");
    expect(result.exitCode).toBe(1);
    expect(agent.alive).toBe(false);
  });
});

describe("createAgent + sendQuiet", () => {
  it("extracts result text from JSON output", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"result","result":"summary text here","duration_ms":50,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.sendQuiet("summarize");
    expect(result).toBe("summary text here");

    agent.kill();
  });

  it("ignores assistant events and only captures result", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"ignored"}]}}\'',
        '  echo \'{"type":"result","result":"only this","duration_ms":50,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.sendQuiet("test");
    expect(result).toBe("only this");

    agent.kill();
  });

  it("resolves with empty string when called on dead process", async () => {
    const script = await makeScript(tempDir, "agent.sh", "exit 0");

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const waitForDeath = async () => {
      for (let i = 0; i < 50; i++) {
        if (!agent.alive) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitForDeath();

    expect(agent.alive).toBe(false);
    const result = await agent.sendQuiet("test");
    expect(result).toBe("");
  });

  it("returns empty string when result event has non-string result field", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"result","result":null,"duration_ms":50,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.sendQuiet("test");
    expect(result).toBe("");

    agent.kill();
  });

  it("works after a prior send() on the same persistent process", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "COUNT=0",
        "while IFS= read -r line; do",
        "  COUNT=$((COUNT + 1))",
        '  echo "{\\\"type\\\":\\\"assistant\\\",\\\"message\\\":{\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"reply $COUNT\\\"}]}}"',
        '  echo \'{"type":"result","result":"summary","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const r1 = await agent.send("first");
    expect(r1.assistantText).toBe("reply 1");

    const quiet = await agent.sendQuiet("summarize");
    expect(quiet).toBe("summary");

    agent.kill();
  });

  it("returns empty string when process dies during sendQuiet", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      ["IFS= read -r line", "exit 1"].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const result = await agent.sendQuiet("test");
    expect(result).toBe("");
  });
});

describe("createAgent + inject", () => {
  it("writes NDJSON with ORCHESTRATOR GUIDANCE framing to agent stdin", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "COUNT=0",
        "while IFS= read -r line; do",
        "  COUNT=$((COUNT + 1))",
        '  printf \'%s\\n\' "$line" >> "$0.stdin.log"',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      sessionId: "inject-test-session",
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    // First send to confirm process is alive
    await agent.send("hello");

    // Now inject guidance
    agent.inject("focus on tests");

    // Wait for the agent to receive and log the injected message
    await agent.send("continue");

    const { readFile } = await import("fs/promises");
    const logged = await readFile(`${script}.stdin.log`, "utf-8");
    const lines = logged.trim().split("\n");

    // The second line should be the injected message (first was "hello", third was "continue")
    const injected = JSON.parse(lines[1]);
    expect(injected.type).toBe("user");
    expect(injected.message.content).toContain("[ORCHESTRATOR GUIDANCE]");
    expect(injected.message.content).toContain("focus on tests");
    expect(injected.session_id).toBe("inject-test-session");

    agent.kill();
  });

  it("inject during send does not let next send resolve with stale inject result", async () => {
    // Race scenario: send("A") → inject("guidance") during flight → send("A") resolves →
    // send("B") called immediately → child reads inject, emits result_inject → send("B")
    // must NOT resolve with inject's result.
    //
    // The child tags each result with a counter so we can verify which result each send gets.
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "COUNT=0",
        "while IFS= read -r line; do",
        "  COUNT=$((COUNT + 1))",
        '  echo "{\\\"type\\\":\\\"assistant\\\",\\\"message\\\":{\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"reply $COUNT\\\"}]}}"',
        '  echo "{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"result-$COUNT\\\",\\\"duration_ms\\\":100,\\\"num_turns\\\":1}"',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    // send("A") → result-1
    const r1 = await agent.send("A");
    expect(r1.resultText).toBe("result-1");

    // inject between sends — child will process this next, producing result-2
    agent.inject("mid-flight guidance");

    // send("B") must get result-3 (its own), not result-2 (inject's)
    const r2 = await agent.send("B");
    expect(r2.resultText).toBe("result-3");
    expect(r2.assistantText).toBe("reply 3");

    agent.kill();
  });

  it("inject during in-flight send resolves send with its own result, not inject's", async () => {
    // Core use case: operator injects while send() promise is still pending.
    // Child responds to each stdin line with a tagged result.
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "COUNT=0",
        "while IFS= read -r line; do",
        "  COUNT=$((COUNT + 1))",
        "  sleep 0.05",
        '  echo "{\\\"type\\\":\\\"assistant\\\",\\\"message\\\":{\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"reply $COUNT\\\"}]}}"',
        '  echo "{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"result-$COUNT\\\",\\\"duration_ms\\\":100,\\\"num_turns\\\":1}"',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    // Start send without awaiting — inject while it's in-flight
    const sendPromise = agent.send("A");

    // Wait for child to start processing, then inject mid-flight
    await new Promise((resolve) => setTimeout(resolve, 20));
    agent.inject("mid-flight guidance");

    const result = await sendPromise;

    // send must resolve with its own result (result-1), not inject's (result-2)
    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("result-1");
    expect(result.assistantText).toBe("reply 1");

    // Let the inject result drain before cleanup
    await new Promise((resolve) => setTimeout(resolve, 150));
    agent.kill();
  });

  it("multiple injects between sends are all drained correctly", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "COUNT=0",
        "while IFS= read -r line; do",
        "  COUNT=$((COUNT + 1))",
        '  echo "{\\\"type\\\":\\\"assistant\\\",\\\"message\\\":{\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"reply $COUNT\\\"}]}}"',
        '  echo "{\\\"type\\\":\\\"result\\\",\\\"result\\\":\\\"result-$COUNT\\\",\\\"duration_ms\\\":100,\\\"num_turns\\\":1}"',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    // send("A") → result-1
    const r1 = await agent.send("A");
    expect(r1.resultText).toBe("result-1");

    // Two injects between sends — child produces result-2 and result-3
    agent.inject("guidance 1");
    agent.inject("guidance 2");

    // send("B") must get result-4 (its own), skipping both inject results
    const r2 = await agent.send("B");
    expect(r2.resultText).toBe("result-4");
    expect(r2.assistantText).toBe("reply 4");

    agent.kill();
  });

  it("does not throw when inject is called on a dead process", async () => {
    const script = await makeScript(tempDir, "agent.sh", "exit 0");

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    const waitForDeath = async () => {
      for (let i = 0; i < 50; i++) {
        if (!agent.alive) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitForDeath();

    expect(agent.alive).toBe(false);
    expect(() => agent.inject("should be no-op")).not.toThrow();
  });
});

describe("createAgent pipe", () => {
  it("returns an object with a callable pipe method", async () => {
    const script = await makeScript(
      tempDir,
      "agent.sh",
      [
        "while IFS= read -r line; do",
        '  echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\'',
        '  echo \'{"type":"result","result":"ok","duration_ms":100,"num_turns":1}\'',
        "done",
      ].join("\n"),
    );

    const agent = createAgent({
      command: script,
      args: [],
      style: { label: "impl", color: "cyan", badge: "I" },
    });

    expect(typeof agent.pipe).toBe("function");
    expect(() => agent.pipe(() => {}, () => {})).not.toThrow();

    agent.kill();
  });
});
