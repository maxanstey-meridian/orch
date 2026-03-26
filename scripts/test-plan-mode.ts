#!/usr/bin/env npx tsx
/**
 * Test script: spawn claude in plan mode, send a prompt, observe output.
 * Goal: understand what plan-mode looks like in stream-json pipe mode.
 */

import { spawn } from "child_process";

const proc = spawn("claude", [
  "--permission-mode", "plan",
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";

proc.stdout!.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            process.stdout.write(`[ASSISTANT] ${block.text}\n`);
          } else if (block.type === "tool_use") {
            process.stdout.write(`[TOOL_USE] ${block.name}: ${JSON.stringify(block.input).slice(0, 100)}\n`);
          }
        }
      } else if (event.type === "result") {
        process.stdout.write(`[RESULT] exit=${event.result ? "has_result" : "empty"} duration=${event.duration_ms}ms turns=${event.num_turns}\n`);
        process.stdout.write(`[RESULT_TEXT] ${String(event.result).slice(0, 500)}\n`);
      } else {
        process.stdout.write(`[EVENT] ${event.type}: ${JSON.stringify(event).slice(0, 200)}\n`);
      }
    } catch {
      process.stdout.write(`[RAW] ${line.slice(0, 200)}\n`);
    }
  }
});

proc.stderr!.on("data", (chunk: Buffer) => {
  process.stderr.write(`[STDERR] ${chunk.toString()}`);
});

proc.on("close", (code) => {
  console.log(`\n[EXIT] code=${code}`);
});

// Send a simple task
const msg = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: "Create a function called `add` in a new file `src/math.ts` that adds two numbers and returns the result. Also write a test for it in `tests/math.test.ts`.",
  },
});

proc.stdin!.write(msg + "\n");

// Kill after 60s if it doesn't finish
setTimeout(() => {
  console.log("\n[TIMEOUT] 60s reached, killing");
  proc.kill("SIGTERM");
}, 60_000);
