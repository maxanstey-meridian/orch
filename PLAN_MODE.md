# Plan-before-execute mode for TDD slices

## Finding

Claude Code supports `--permission-mode plan` in pipe mode with `stream-json`. When used:

1. The agent explores, reads files, uses subagents — all read-only tools work
2. It writes a plan to a file in `~/.claude/plans/`
3. It calls `ExitPlanMode` tool when the plan is ready
4. The `ExitPlanMode` tool use contains the full plan text in its `input.plan` field
5. The result event fires with empty text — the agent stops

## Observed stream events (in order)

```
[system]     init — session started
[assistant]  text + tool_use (Agent/Explore, Read, Bash — research)
[assistant]  text + tool_use (Write — writes plan to ~/.claude/plans/<name>.md)
[assistant]  tool_use (ExitPlanMode — plan field contains full plan text)
[user]       tool_result with is_error: true, content: "Exit plan mode?"
[result]     empty text, agent stops
```

## Proposed flow

```
For each slice:
  1. Spawn claude --permission-mode plan -p --input-format stream-json --output-format stream-json --verbose --append-system-prompt <tdd-skill>
  2. Send slice prompt (with brief on first message)
  3. Stream events, watch for:
     - Questions (detectQuestion / needsInput) → forward to operator via hud.askUser
     - ExitPlanMode tool_use → plan is ready, extract plan text from input.plan
  4. Kill the plan agent
  5. Spawn fresh claude --dangerously-skip-permissions -p --input-format stream-json --output-format stream-json --verbose --append-system-prompt <tdd-skill>
  6. Send: "Execute this plan:\n\n{plan text}"
  7. Normal flow: commit sweep → verify → review
```

## Detection

The `ExitPlanMode` signal is reliable — it's a tool_use event with `name: "ExitPlanMode"` and `input.plan` containing the plan markdown. No fuzzy text matching needed.

In the agent.ts event stream, this appears as:
```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "name": "ExitPlanMode",
        "input": {
          "plan": "# Plan: ...",
          "allowedPrompts": [...]
        }
      }
    ]
  }
}
```

## Open questions

- Should the plan agent get the TDD skill, or a separate planning-focused skill? The TDD skill is about execution methodology — a plan agent might benefit from a prompt focused on breaking down the slice into steps.
- Should the plan be shown to the operator before auto-accepting? Could add a hud.askUser confirmation step.
- How to handle the plan agent asking questions mid-planning — currently followUpIfNeeded handles this for the TDD bot, same pattern should work.
- The plan agent writes to `~/.claude/plans/` — should we clean that up after extracting the plan text, or leave it for debugging?

## Test script

`scripts/test-plan-mode.ts` — standalone script that spawns a plan-mode agent and logs all events. Run with `npx tsx scripts/test-plan-mode.ts`.
