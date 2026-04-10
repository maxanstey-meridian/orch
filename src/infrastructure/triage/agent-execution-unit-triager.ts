import { AgentSpawner } from "#application/ports/agent-spawner.port.js";
import {
  ExecutionUnitTriager,
  type ExecutionUnitTriageInput,
} from "#application/ports/execution-unit-triager.port.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { FULL_TRIAGE, type BoundaryTriageResult } from "#domain/triage.js";
import { buildTriagePrompt, parseTriageResult } from "#infrastructure/triage/diff-triage.js";

export class AgentExecutionUnitTriager extends ExecutionUnitTriager {
  constructor(
    private readonly agents: AgentSpawner,
    private readonly config: OrchestratorConfig,
  ) {
    super();
  }

  async decide(input: ExecutionUnitTriageInput): Promise<BoundaryTriageResult> {
    if (input.diff.trim().length === 0) {
      return {
        completeness: "skip",
        verify: "skip",
        review: "skip",
        gap: "skip",
        reason: "empty diff",
      };
    }

    try {
      const agent = this.agents.spawn("triage", { cwd: this.config.cwd });
      const result = await agent.send(buildTriagePrompt(input));
      agent.kill();
      const triageText =
        result.assistantText.trim().length > 0 ? result.assistantText : result.resultText;
      return parseTriageResult(triageText);
    } catch {
      return FULL_TRIAGE;
    }
  }
}
