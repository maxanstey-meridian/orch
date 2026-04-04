import {
  ExecutionUnitTierSelector,
  type ExecutionUnitTierInput,
} from "#application/ports/execution-unit-tier-selector.port.js";
import type { ComplexityTriageResult } from "#domain/triage.js";
import type { FakeAgentSpawner } from "./fake-agent-spawner.js";

export class FakeExecutionUnitTierSelector extends ExecutionUnitTierSelector {
  readonly inputs: ExecutionUnitTierInput[] = [];
  private readonly queued: ComplexityTriageResult[] = [];

  queueResult(...results: ComplexityTriageResult[]): void {
    this.queued.push(...results);
  }

  constructor(private readonly spawner?: FakeAgentSpawner) {
    super();
  }

  async select(input: ExecutionUnitTierInput): Promise<ComplexityTriageResult> {
    this.inputs.push(input);
    if (this.queued.length > 0) {
      return this.queued.shift()!;
    }

    if (this.spawner) {
      const agent = this.spawner.spawn("triage", { cwd: "/tmp/test-tier" });
      try {
        const result = await agent.send(input.content);
        const text = result.assistantText.trim().length > 0 ? result.assistantText : result.resultText;
        const parsed = JSON.parse(text) as ComplexityTriageResult;
        if (parsed.tier && parsed.reason) {
          return parsed;
        }
      } catch {
        // Fall through to heuristic fallback.
      } finally {
        agent.kill();
      }
    }

    return {
      tier: "medium",
      reason: "fake execution-unit tier",
    };
  }
}
