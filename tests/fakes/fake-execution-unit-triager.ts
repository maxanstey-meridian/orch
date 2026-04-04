import {
  ExecutionUnitTriager,
  type ExecutionUnitTriageInput,
} from "#application/ports/execution-unit-triager.port.js";
import { buildTriagePrompt, parseTriageResult } from "#infrastructure/diff-triage.js";
import type { BoundaryTriageResult } from "#domain/triage.js";
import type { FakeAgentSpawner } from "./fake-agent-spawner.js";

export class FakeExecutionUnitTriager extends ExecutionUnitTriager {
  readonly inputs: ExecutionUnitTriageInput[] = [];
  private readonly queued: BoundaryTriageResult[] = [];

  queueResult(...results: BoundaryTriageResult[]): void {
    this.queued.push(...results);
  }

  constructor(private readonly spawner?: FakeAgentSpawner) {
    super();
  }

  async decide(input: ExecutionUnitTriageInput): Promise<BoundaryTriageResult> {
    this.inputs.push(input);
    if (this.queued.length > 0) {
      return this.queued.shift()!;
    }

    if (this.spawner) {
      const agent = this.spawner.spawn("triage", { cwd: "/tmp/test-triage" });
      try {
        const result = await agent.send(buildTriagePrompt(input));
        const text = result.assistantText.trim().length > 0 ? result.assistantText : result.resultText;
        return parseTriageResult(text);
      } catch {
        // Fall through to heuristic fallback.
      } finally {
        agent.kill();
      }
    }

    const directMode = input.mode === "direct";
    const finalGroupBoundary = input.unitKind === "group" && input.finalBoundary;

    return (
      {
        completeness: directMode ? "skip" : "run_now",
        verify: "run_now",
        review:
          directMode || input.diffStats.total < input.reviewThreshold ? "skip" : "run_now",
        gap:
          input.unitKind === "slice" && !input.finalBoundary
            ? "defer"
            : input.pending.gap || finalGroupBoundary || input.finalBoundary
              ? "run_now"
              : "skip",
        reason: "fake runtime policy",
      }
    );
  }
}
