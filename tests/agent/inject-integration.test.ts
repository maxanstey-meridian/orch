import { describe, it, expect } from "vitest";
import { createClaudeAgent as createAgent } from "../../src/infrastructure/claude/claude-agent-process.js";

/**
 * Integration tests that spawn a real `claude` process to verify
 * inject() actually reaches the agent and influences its response.
 *
 * These tests require `claude` to be installed and on PATH.
 * They use real API credits — keep prompts minimal.
 */

const TIMEOUT = 60_000;

const hasClaudeCli = (): boolean => {
  try {
    const { execSync } = require("child_process");
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const describeIf = (condition: boolean) =>
  condition ? describe : describe.skip;

describe.skip("inject integration (real claude)", () => {
  it(
    "inject() during active send is received and visible in the next turn",
    async () => {
      const agent = createAgent({
        command: "claude",
        args: [
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
        ],
        cwd: process.cwd(),
        style: { label: "test", color: "\x1b[36m", badge: "[TEST]" },
      });

      try {
        // Start a task, inject mid-flight — inject won't interrupt the
        // current turn but will be processed as a follow-up turn whose
        // result is drained. The guidance lands in Claude's context.
        const sendPromise = agent.send("Say exactly: FIRST_TURN_OK");

        // Inject while the first send is in flight
        agent.inject("Remember the secret word GIRAFFE.");

        await sendPromise;

        // The inject was processed between turns (result drained).
        // A subsequent send should see the injected context.
        const r2 = await agent.send(
          "What secret word were you told to remember? Reply with exactly: SECRET_<word>",
        );

        expect(r2.assistantText).toContain("GIRAFFE");
      } finally {
        agent.kill();
      }
    },
    TIMEOUT,
  );

  it(
    "inject() during active send does not corrupt subsequent send",
    async () => {
      const agent = createAgent({
        command: "claude",
        args: [
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
        ],
        cwd: process.cwd(),
        style: { label: "test", color: "\x1b[36m", badge: "[TEST]" },
      });

      try {
        // First send — establish session
        const r1 = await agent.send("Say exactly: FIRST_OK");
        expect(r1.assistantText).toContain("FIRST_OK");

        // Inject between sends
        agent.inject("Remember the word BANANA for later.");

        // Second send should work normally and not be corrupted
        const r2 = await agent.send(
          "Say exactly: SECOND_OK. Also, what word were you asked to remember?",
        );
        expect(r2.assistantText).toContain("SECOND_OK");
        expect(r2.assistantText).toContain("BANANA");
      } finally {
        agent.kill();
      }
    },
    TIMEOUT,
  );
});
